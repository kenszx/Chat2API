import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

const script = 'skills/chat2api-management-api/scripts/management-api.mjs'
const skill = 'skills/chat2api-management-api/SKILL.md'

test('management helper has documented commands', () => {
  const text = fs.readFileSync(script, 'utf8')
  assert.match(text, /command === 'snapshot'/)
  assert.match(text, /command === 'create-api-key'/)
  assert.match(text, /command === 'delete-api-key'/)
  assert.match(text, /command === 'restore-tool-config'/)
  assert.match(text, /maskSecret/)
})

test('management helper prints safe dry-run output without leaking secret', () => {
  const result = spawnSync('node', [script, 'snapshot', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_BASE_URL: 'http://127.0.0.1:8080',
      CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /snapshot/)
  assert.doesNotMatch(result.stdout, /mgmt_super_secret_value/)
})

test('management skill documents every helper command', () => {
  const text = fs.readFileSync(skill, 'utf8')
  const commandsSection = text.split('## Commands')[1]?.split('\n## ')[0] || ''

  assert.match(commandsSection, /management-api\.mjs snapshot/)
  assert.match(commandsSection, /management-api\.mjs create-api-key/)
  assert.match(commandsSection, /management-api\.mjs delete-api-key/)
  assert.match(commandsSection, /management-api\.mjs restore-tool-config/)
})
