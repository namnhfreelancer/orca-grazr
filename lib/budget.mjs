import { KILL_GRACE_MS } from './exec.mjs'

// Orca kills a command at 30 s. A child process gets KILL_GRACE_MS after SIGTERM before SIGKILL,
// so every timeout cut from a deadline leaves that much of it to the kill.
export { KILL_GRACE_MS }

// Below this much usable time a status run cannot finish, so the work is skipped rather than cut off.
export const MIN_BUDGET_MS = 3000

// The time a child may use of what is left before a deadline, after the kill grace is set aside.
export const usableMs = (leftMs) => leftMs - KILL_GRACE_MS

export const hasBudget = (leftMs) => usableMs(leftMs) >= MIN_BUDGET_MS
