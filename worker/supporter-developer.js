import { PLAN_FEATURES } from '../site/supporter/plan-features.js';

const DISCORD_ID = /^\d{17,20}$/;

export function supporterDeveloperIds(env = {}) {
 return [...new Set(String(env.SUPPORTER_DEVELOPER_IDS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(value => DISCORD_ID.test(value)))];
}

export function isSupporterDeveloper(env, discordUserId) {
 return supporterDeveloperIds(env).includes(String(discordUserId ?? ''));
}

export function developerSubscriptionSummary() {
 return {
  developer: true,
  recognizedPlan: true,
  planId: 'pro',
  plan: '開発者（無料）',
  status: 'active',
  unlimited: true,
  servers: null,
  channels: null,
  rules: null,
  complexConditions: true,
  multiDestination: true,
  amount: 0,
  currency: 'jpy',
  items: [],
 };
}

export function developerLimits() {
 return {
  unlimited: true,
  servers: Infinity,
  channels: Infinity,
  rules: Infinity,
  complexConditions: true,
  multiDestination: true,
  ...PLAN_FEATURES.pro,
 };
}
