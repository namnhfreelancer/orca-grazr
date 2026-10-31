import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planLabel } from '../lib/panel-data.mjs'

// Anthropic's 2026-10-30 rename: Max 20x is Ultra, Max 5x is Max.
test('a Max plan at 20x is Ultra and at 5x is Max, whichever of seat_tier or tier carries the multiplier', () => {
  assert.equal(planLabel({ type: 'claude_max', seat_tier: 'default_claude_max_20x' }), 'Ultra')
  assert.equal(planLabel({ type: 'claude_max', tier: 'default_claude_max_20x' }), 'Ultra')
  assert.equal(planLabel({ type: 'claude_max', seat_tier: 'default_claude_max_5x' }), 'Max')
  assert.equal(planLabel({ type: 'claude_max', tier: 'default_claude_max_5x' }), 'Max')
  assert.equal(planLabel({ type: 'claude_max', seat_tier: 'default_claude_max_5x', tier: 'default_claude_max_20x' }), 'Max', 'seat_tier wins, as it does for every plan')
})

test('a Max plan with no multiplier is Max', () => {
  assert.equal(planLabel({ type: 'claude_max' }), 'Max')
  assert.equal(planLabel({ type: 'claude_max', tier: 'default', seat_tier: null }), 'Max')
})

test('a Max plan at any other multiplier keeps it', () => {
  assert.equal(planLabel({ type: 'claude_max', tier: 'default_claude_max_10x' }), 'Max 10x')
})

test('a type or tier containing ultra is Ultra, whatever the case or the multiplier', () => {
  assert.equal(planLabel({ type: 'claude_ultra' }), 'Ultra')
  assert.equal(planLabel({ type: 'claude_ultra', tier: 'default_claude_ultra' }), 'Ultra')
  assert.equal(planLabel({ type: 'claude_max', tier: 'default_claude_ultra' }), 'Ultra')
  assert.equal(planLabel({ type: 'claude_max', seat_tier: 'default_claude_ULTRA_5x' }), 'Ultra')
  assert.equal(planLabel({ type: 'claude_ultra', seat_tier: 'default_claude_max_5x' }), 'Ultra')
  assert.equal(planLabel({ type: 'CLAUDE_ULTRA' }), 'Ultra')
})

test('Pro, Team and Enterprise keep their names and any multiplier they show', () => {
  assert.equal(planLabel({ type: 'claude_pro' }), 'Pro')
  assert.equal(planLabel({ type: 'claude_pro', tier: 'default_claude_pro_5x' }), 'Pro 5x')
  assert.equal(planLabel({ type: 'claude_team', tier: 'default_claude_max_20x' }), 'Team 20x')
  assert.equal(planLabel({ type: 'claude_enterprise', tier: 'enterprise' }), 'Enterprise')
})
