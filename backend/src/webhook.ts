import * as Stripe from 'stripe'
import * as Airtable from 'airtable'
import {
  findUserByApiKey,
  findUserByStripeId,
  updateUser,
  findUserByCheckoutSessionId,
} from './storage'
import { _handler } from './_handler'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const airtable = new Airtable({
  endpointUrl: 'https://api.airtable.com',
  apiKey: process.env.AIRTABLE_API_KEY,
}).base(process.env.AIRTABLE_TABLE_ID)

class BadRequest extends Error {
  status = 400
}

class NotFound extends Error {
  status = 404
}

async function getNumberOfTrees(
  subscription: Stripe.subscriptions.ISubscription,
  starting_after?: string
): Promise<number> {
  const list = await stripe.usageRecordSummaries.list(subscription.id, {
    starting_after: starting_after,
  })

  return (
    list.data.reduce((prev, x) => prev + x.total_usage, 0) +
    (list.has_more
      ? await getNumberOfTrees(subscription, list.data[list.data.length - 1].id)
      : 0)
  )
}

export const zapierPlantTree = _handler(async event => {
  let { apiKey, trees } = event.queryStringParameters
  if (!apiKey) {
    throw new BadRequest('Missing `apiKey` query parameter')
  }

  let data = await findUserByApiKey(apiKey)

  if (!data) {
    throw new NotFound('Could not find the user')
  }

  if (!data.subscriptionId) {
    throw new BadRequest(
      `It seems that you haven't setup your credit card details yet. Please head to ${process.env.FRONTEND_URL}/dashboard.`
    )
  }

  const quantity = typeof trees !== 'undefined' ? parseInt(trees, 10) : 1
  const subscription = await stripe.subscriptions.retrieve(data.subscriptionId)

  await stripe.usageRecords.create(subscription.items.data[0].id, {
    quantity,
    timestamp: Math.floor(Date.now() / 1000),
  })

  data = await updateUser(data, {
    trees: data.trees + quantity,
    credit: data.credit - quantity,
  })

  return {
    trees: data.trees,
  }
})

function isSubscription(
  object: Stripe.IObject
): object is Stripe.subscriptions.ISubscription {
  return object.object === 'subscription'
}

function isCheckoutSession(
  object: Stripe.IObject
): object is Stripe.checkouts.sessions.ICheckoutSession {
  return object.object === 'checkout.session'
}

export const stripeWebhook = _handler(async event => {
  let sig = event.headers['Stripe-Signature']
  let stripeEvent: Stripe.events.IEvent

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_ENDPOINT_SECRET
    )
  } catch (err) {
    throw new BadRequest(err.message)
  }

  switch (stripeEvent.type) {
    case 'checkout.session.completed': {
      const session = stripeEvent.data.object
      if (isCheckoutSession(session)) {
        const user = await findUserByCheckoutSessionId(session.id)
        if (!user) {
          return {
            message: 'missing user',
          }
        }

        // @ts-ignore
        const setupIntent = await stripe.setupIntents.retrieve(
          // @ts-ignore
          session.setup_intent
        )

        await stripe.paymentMethods.attach(setupIntent.payment_method, {
          customer: user.stripeId,
        })

        if (user.subscriptionId) {
          return {
            message: 'attached the payment method',
          }
        }

        const subscription = await stripe.subscriptions.create({
          customer: user.stripeId,
          items: [
            {
              plan: 'meteredtreeplanted',
            },
          ],
        })

        await updateUser(user, {
          subscriptionId: subscription.id,
          checkoutSessionId: undefined,
        })

        return {
          message: 'attached the payment method and created the subscription',
        }
      }
    }
    case 'customer.subscription.deleted': {
      const subscription = stripeEvent.data.object
      if (isSubscription(subscription) && subscription.status !== 'active') {
        const customer = await stripe.customers.retrieve(
          subscription.customer as string
        )
        const user = await findUserByStripeId(customer.id)
        if (!user) {
          return {
            message: 'missing user',
          }
        }

        await updateUser(user, {
          subscriptionId: undefined,
        })

        return {
          message: 'removed subscription',
        }
      }
    }
    case 'invoice.payment_succeeded': {
      const subscription = stripeEvent.data.object
      if (isSubscription(subscription)) {
        const customer = await stripe.customers.retrieve(
          subscription.customer as string
        )
        const user = await findUserByStripeId(customer.id)
        if (!user) {
          return {
            message: 'missing user',
          }
        }

        const numberOfTrees = await getNumberOfTrees(subscription)

        await airtable('Ledger').create({
          Timestamp: new Date(
            subscription.latest_invoice.period_end
          ).toISOString(),
          'Number of trees': numberOfTrees,
          'Stripe ID': user.stripeId,
        })

        await updateUser(user, {
          credit: user.credit - numberOfTrees,
        })

        return {
          message: 'got it',
        }
      }
    }
    default:
      return {
        message: 'I am not handling that',
      }
  }
})
