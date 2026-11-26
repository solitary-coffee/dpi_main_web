const activeStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

export function supporterStats(accounts = []) {
 const subscriptions = accounts.flatMap(account => account.subscriptions || []);
 const active = subscriptions.filter(subscription =>
  activeStatuses.has(subscription.status)
  && (subscription.recognizedPlan !== false || Boolean(subscription.customId)));
 const planCounts = {supporter: 0, plus: 0, pro: 0, custom: 0};

 for (const subscription of active) {
  const plan = subscription.customId ? 'custom' : subscription.planId;
  if (Object.hasOwn(planCounts, plan)) planCounts[plan] += 1;
 }

 return {
  subscriptions,
  active,
  planCounts,
  monthlyAmount: active.reduce((sum, subscription) => sum + Number(subscription.amount || 0), 0),
  cancelingCount: active.filter(subscription => subscription.cancelAtPeriodEnd).length,
 };
}
