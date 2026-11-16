// Public inspection vocabulary shared by Gateway validation and the memory UI.
export const MEMORY_SECTION_ALIASES = { intents: 'user_intents', activities: 'user_activity', states: 'user_states' }
export const MEMORY_SECTIONS = {
  user_claims: { types: ['identity_profile', 'affiliation', 'relationship', 'judgment', 'preference', 'constraint', 'behavior_pattern'],
    statuses: ['candidate', 'active', 'weakened', 'superseded', 'expired', 'retracted'],
    filters: ['claimType', 'origin', 'subjectId', 'status', 'domain'] },
  user_intents: { types: ['goal', 'plan', 'work_item'],
    statuses: ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'], filters: ['type', 'scope', 'status', 'domain'] },
  user_activity: { types: [], statuses: [], filters: ['role', 'from', 'to'] },
  user_thread: { types: [], statuses: ['active', 'closed'], filters: ['status'] },
  user_observed_pattern: { types: [], statuses: [], filters: ['subjectId', 'domain'] },
  user_states: { types: ['situational_state', 'recurring_state', 'enduring_state'],
    statuses: ['active', 'weakened', 'expired'], filters: ['type', 'scope', 'status', 'domain'] },
}
export function canonicalMemorySection(section) { return MEMORY_SECTION_ALIASES[section] || section }
export function memorySection(section) { return MEMORY_SECTIONS[canonicalMemorySection(section)] }
