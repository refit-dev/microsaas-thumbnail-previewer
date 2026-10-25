import { stripe } from "@/lib/stripe"
import Stripe from "stripe"
import prisma from "@/lib/db"
import { headers } from "next/headers"

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodStart(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_start', planItem);
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

export async function POST(req: Request) {
    const body = await req.text()

    const signature = headers().get("Stripe-Signature") as string

    let event: Stripe.Event

    try {
        event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET as string)
    } catch (error) {
        console.error("Webhook signature verification failed:", error)
        return new Response("Webhook Error: ", { status: 400})
    }

    const session = event.data.object as Stripe.Checkout.Session

    if (event.type === "checkout.session.completed") {
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string)

        const user = await prisma.user.findUnique({
            where: {
                stripeCustomerId: session.customer as string
            }
        })

        if (!user) {
            return new Response("User not found", { status: 404 })
        }

        await prisma.subscription.create({
            data: {
                userId: user.id,
                stripeSubscriptionId: subscription.id,
                currentPeriodEnd: new Date((getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000),
                currentPeriodStart: new Date((getSubscriptionPeriodStart(subscription, (items) => items[0])) * 1000),
                interval: subscription.items.data[0].plan.interval,
                planId: subscription.items.data[0].plan.id,
                status: subscription.status
            }
        })
    }


    if (event.type === "invoice.payment_succeeded"){
        const subscription = await stripe.subscriptions.retrieve((getInvoiceSubscription(session)) as string)

        await prisma.subscription.update({
            where: {
                stripeSubscriptionId: subscription.id
            },
            data: {
                status: subscription.status,
                currentPeriodEnd: new Date((getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000)
            }
        })
    }


    if (event.type === "customer.subscription.updated") {
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string)

        await prisma.subscription.update({
            where: {
                stripeSubscriptionId: subscription.id
            },
            data: {
                currentPeriodEnd: new Date((getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000),
                currentPeriodStart: new Date((getSubscriptionPeriodStart(subscription, (items) => items[0])) * 1000),
                interval: subscription.items.data[0].plan.interval,
                planId: subscription.items.data[0].plan.id,
                status: subscription.cancel_at_period_end ? "cancelling" : subscription.status
            }
        })
    }


    if (event.type === "customer.subscription.deleted") {
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string)

        await prisma.subscription.update({
            where: {
                stripeSubscriptionId: subscription.id
            },
            data: {
                status: subscription.status
            }
        })
    }

    return new Response(null, { status: 200 })
}