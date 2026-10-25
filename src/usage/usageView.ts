import type { GetUsageResponse, UsageWindow } from '../claude/sdkTypes';
import type { UsageView, UsageWindowView } from '../shared/protocol';

/** Converts the CLI's get_usage answer into what the status bar and dashboard show. */
export function toView(res: GetUsageResponse): UsageView {
  const rl = res.rate_limits ?? undefined;
  const w = (x: UsageWindow | null | undefined): UsageWindowView | undefined =>
    x ? { percent: typeof x.utilization === 'number' ? Math.round(x.utilization) : null, resetsAt: x.resets_at ?? null } : undefined;
  const others: UsageView['others'] = [];
  const opus = w(rl?.seven_day_opus);
  if (opus) others.push({ label: 'Opus', window: opus });
  const sonnet = w(rl?.seven_day_sonnet);
  if (sonnet) others.push({ label: 'Sonnet', window: sonnet });
  for (const m of rl?.model_scoped ?? []) {
    if (!m?.display_name || others.some((o) => o.label === m.display_name)) continue;
    others.push({ label: m.display_name, window: { percent: typeof m.utilization === 'number' ? Math.round(m.utilization) : null, resetsAt: m.resets_at ?? null } });
  }
  if (!res.rate_limits_available && !rl) {
    return { others, error: 'Usage limits are only available with a Claude subscription login.', subscription: res.subscription_type ?? undefined };
  }
  return { fiveHour: w(rl?.five_hour), sevenDay: w(rl?.seven_day), others, subscription: res.subscription_type ?? undefined };
}
