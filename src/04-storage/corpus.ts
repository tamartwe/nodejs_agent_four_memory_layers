/**
 * A realistic long-term store: runbook fragments, past decisions, ticket notes,
 * and — crucially — a lot of conversational filler.
 *
 * The filler is not padding for the demo. It is what your store actually looks
 * like if you embed every message. That is the point of Layer 4.
 */

export type DocKind = 'decision' | 'runbook' | 'fact' | 'chatter';

export interface Doc {
  id: string;
  kind: DocKind;
  text: string;
}

export const DOCS: Doc[] = [
  // ── durable, high-signal facts ──────────────────────────────────────────
  { id: 'd01', kind: 'decision', text: 'Change request CR-88214 covers the 1,200 gateway firmware rollout. Approved rollback window is 40 minutes from the start of each stage.' },
  { id: 'd02', kind: 'decision', text: 'Canary stage for fleet rollouts is fixed at 2% of the region, minimum 20 devices, held for one full telemetry cycle before promotion.' },
  { id: 'd03', kind: 'runbook', text: 'If a gateway fails to check in for 3 consecutive telemetry cycles after a firmware push, treat it as bricked. Do not attempt remote recovery. Dispatch for physical reflash via the serial console.' },
  { id: 'd04', kind: 'runbook', text: 'Halt criteria for any staged rollout: more than 0.5% of the stage cohort failing health checks, or any single device entering a boot loop.' },
  { id: 'd05', kind: 'fact', text: 'Telemetry pipeline is Kafka into ClickHouse with roughly 90 seconds of end to end lag. Gating logic must tolerate that lag or it will promote on stale data.' },
  { id: 'd06', kind: 'fact', text: 'Firmware 3.1.0 has a known network stack regression under IPv6-only networks. 90 devices in the fleet are still pinned to it.' },
  { id: 'd07', kind: 'decision', text: 'Maintenance window is Sunday 22:00 to 00:00 Israel time. Two hours total. Stage one and stage two cannot both fit; stage two moves to the following week.' },
  { id: 'd08', kind: 'fact', text: 'Regions in production are eu-west-1, us-east-1 and ap-south-1. eu-west-1 carries approximately 60% of fleet traffic.' },
  { id: 'd09', kind: 'runbook', text: 'ap-south-1 has no on-call coverage between 02:00 and 06:00 UTC. Any rollout stage touching ap-south-1 must complete before 02:00 UTC.' },
  { id: 'd10', kind: 'decision', text: 'Incident severity mapping: P1 is fleet-wide outage, P2 is regional degradation, P3 is single-site, P4 is cosmetic. Severity strings outside P1..P4 are rejected by the incident API.' },
  { id: 'd11', kind: 'fact', text: 'SKU-1102, the LoRa relay board, has been at zero on-hand stock since the March supplier change. Lead time is 11 weeks.' },
  { id: 'd12', kind: 'runbook', text: 'Post-mortem requires: the change request ID, the halt decision timestamp, per-stage health check output, and the raw telemetry export for any device that failed.' },

  // ── conversational filler: this is what "embed everything" gives you ─────
  { id: 'n01', kind: 'chatter', text: 'Sounds good, let me know when you have the numbers.' },
  { id: 'n02', kind: 'chatter', text: 'Thanks, that is really helpful. I will loop in the platform team.' },
  { id: 'n03', kind: 'chatter', text: 'Can you say more about that? I am not sure I follow the second part.' },
  { id: 'n04', kind: 'chatter', text: 'Happy to help. Let me know if you want me to draft the checklist as well.' },
  { id: 'n05', kind: 'chatter', text: 'I think we discussed this last quarter but I do not remember the outcome.' },
  { id: 'n06', kind: 'chatter', text: 'Good morning. Picking up where we left off yesterday on the rollout planning.' },
  { id: 'n07', kind: 'chatter', text: 'That makes sense. What would you do about the devices in the other region?' },
  { id: 'n08', kind: 'chatter', text: 'Let me check with the team and come back to you on the timing.' },
  { id: 'n09', kind: 'chatter', text: 'One second, pulling up the dashboard now.' },
  { id: 'n10', kind: 'chatter', text: 'Right, so the rollout is basically a staged deployment with health gating between stages.' },
  { id: 'n11', kind: 'chatter', text: 'We should probably write this down somewhere the on-call engineer will actually find it.' },
  { id: 'n12', kind: 'chatter', text: 'Agreed on the approach. Anything else I should be worried about?' },
  { id: 'n13', kind: 'chatter', text: 'The deployment went fine last time so I am not too concerned.' },
  { id: 'n14', kind: 'chatter', text: 'Let us revisit the monitoring question once the firmware plan is settled.' },
  { id: 'n15', kind: 'chatter', text: 'Perfect, that answers it. Moving on to the next topic.' },
  { id: 'n16', kind: 'chatter', text: 'I will need to check whether the maintenance window is still on for this week.' },
  { id: 'n17', kind: 'chatter', text: 'Could you summarise the risks one more time before we wrap up?' },
  { id: 'n18', kind: 'chatter', text: 'Noted. I will add that to the runbook draft.' },
];

export type QueryKind = 'exact-match' | 'semantic' | 'absent';

export interface Query {
  id: string;
  text: string;
  kind: QueryKind;
  relevant: string[];
}

/**
 * Three queries, chosen because they fail differently:
 *
 *  Q1  EXACT MATCH. The answer is a literal token, CR-88214. Vectors are bad
 *      at this — identifiers have no semantic neighbourhood.
 *  Q2  SEMANTIC. The query and the document share almost no vocabulary
 *      ("won't come back online" vs "fails to check in"). Vectors win here.
 *  Q3  NOT IN THE CORPUS. Cosine similarity ALWAYS returns k results. This is
 *      where naive top-k manufactures confident nonsense.
 */
export const QUERIES: Query[] = [
  {
    id: 'Q1',
    text: 'What is the approved rollback window for CR-88214?',
    kind: 'exact-match',
    relevant: ['d01'],
  },
  {
    id: 'Q2',
    text: 'A device will not come back online after we flashed it. What now?',
    kind: 'semantic',
    relevant: ['d03', 'd04'],
  },
  {
    id: 'Q3',
    text: 'What did we spend on cloud hosting last month?',
    kind: 'absent',
    relevant: [],
  },
];
