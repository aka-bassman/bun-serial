// Publish to npm by hand: check the repository and the npm login, apply any
// pending changesets, run the checks, ask, commit the version bump, publish
// through Changesets (npm publish, then a git tag), and push the commit and tag.
//
//   bun run publish:npm              publish
//   bun run publish:npm --dry-run    everything up to the publish, as npm publish --dry-run; changes nothing
//   bun run publish:npm --otp 123456 a one-time password for npm (asked for otherwise)
//
// Run it again after a failed publish: with the version committed and still
// not on npm, it picks up where it stopped.

import { $ } from 'bun'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const otpIndex = args.indexOf('--otp')
let otp = otpIndex >= 0 ? args[otpIndex + 1] : undefined
if (otpIndex >= 0 && !otp) fail('--otp needs a code')

process.chdir(fileURLToPath(new URL('..', import.meta.url)))

function fail(message: string): never {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}
const step = (message: string) => console.log(`\n▸ ${message}`)
const ok = async (command: ReturnType<typeof $>) => (await command.nothrow().quiet()).exitCode === 0

// On this terminal, not through a pipe: npm asks for a one-time password
// only when its stdin and stdout are both a TTY.
async function run(command: string[], env: Record<string, string> = {}): Promise<boolean> {
  const child = Bun.spawn(command, { stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, ...env } })
  return (await child.exited) === 0
}

const readPackage = () => JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string }
const { baseBranch } = JSON.parse(readFileSync('.changeset/config.json', 'utf8')) as { baseBranch: string }
const pendingChangesets = () => readdirSync('.changeset').filter((f) => f.endsWith('.md') && f !== 'README.md')

// Puts back what `changeset version` changed; the tree was clean before it.
async function undoVersion(): Promise<void> {
  await $`git restore --staged --worktree .`.quiet()
}

// 1. Preconditions.
step('Checking git and npm')
if (!(await ok($`git rev-parse --verify HEAD`))) fail('Not a git repository with a commit: git init and commit first.')
const branch = (await $`git branch --show-current`.text()).trim()
if (branch !== baseBranch) fail(`On branch ${branch || '(detached HEAD)'}: release from ${baseBranch}.`)
if ((await $`git status --porcelain`.text()).trim()) fail('Uncommitted changes: commit or stash them first.')
const npmUser = (await $`npm whoami`.nothrow().quiet().text()).trim()
if (!npmUser && !dryRun) fail('Not logged in to npm: run npm login.')
console.log(`  ${branch}, clean; npm user ${npmUser || '(none — fine for a dry run)'}`)

// 2. The version to publish.
const pending = pendingChangesets()
if (pending.length > 0) {
  step(`Applying ${pending.length} changeset(s)`)
  if (!(await run(['bunx', 'changeset', 'version']))) fail('changeset version failed.')
}
const { name, version } = readPackage()
const bumped = pending.length > 0
const published = (await $`npm view ${`${name}@${version}`} version`.nothrow().quiet().text()).trim() === version
if (published) {
  if (bumped) await undoVersion()
  fail(`${name}@${version} is already on npm. Describe your changes with bun run changeset first.`)
}

step(`Release ${name}@${version}`)
const changelog = readFileSync('CHANGELOG.md', 'utf8').split('\n')
const start = changelog.findIndex((line) => line === `## ${version}`)
if (start < 0) console.log('  (no CHANGELOG.md section for this version)')
else {
  const end = changelog.findIndex((line, i) => i > start && line.startsWith('## '))
  const section = changelog.slice(start, end < 0 ? undefined : end)
  console.log(section.slice(0, 30).map((line) => `  ${line}`).join('\n'))
  if (section.length > 30) console.log(`  … ${section.length - 30} more lines in CHANGELOG.md`)
}

// 3. A dry run rehearses the publish, prepublishOnly checks included, then undoes the bump.
if (dryRun) {
  step('npm publish --dry-run')
  const rehearsed = await run(['npm', 'publish', '--dry-run', '--access', 'public'])
  if (bumped) await undoVersion()
  if (!rehearsed) fail('The dry run failed.')
  console.log(`\n✔ Dry run done; nothing was changed or published.`)
  process.exit(0)
}

// 4. The checks prepublishOnly would run, before anything is committed or published.
step('Typecheck, tests, build, consumer typecheck')
if (!(await run(['bun', 'run', 'prepublishOnly']))) {
  if (bumped) await undoVersion()
  fail('The checks failed; nothing was published.')
}

const upstream = (await $`git rev-parse --abbrev-ref --symbolic-full-name ${'@{u}'}`.nothrow().quiet().text()).trim()
const question = `Publish ${name}@${version} to npm${upstream ? ` and push to ${upstream}` : ''}?`
if (!confirm(question)) {
  if (bumped) await undoVersion()
  fail('Stopped; nothing was published.')
}

// 5. Commit the bump, so the tag Changesets makes points at it.
if (bumped) {
  step('Committing the version bump')
  await $`git add -A`
  await $`git commit -m ${`chore(release): ${name}@${version}`}`
}

// 6. Publish and tag. The one-time password is asked for last, so it is
// still fresh when npm sends it; the checks just ran, so npm skips
// prepublishOnly. A code that has expired makes npm ask again.
otp ??= prompt('npm one-time password (Enter if your account has no 2FA):')?.trim() || undefined
step(`Publishing ${name}@${version}`)
const publishedNow = await run(['bunx', 'changeset', 'publish', ...(otp ? ['--otp', otp] : [])], {
  npm_config_ignore_scripts: 'true',
})
if (!publishedNow) {
  fail(`Publishing failed. ${bumped ? 'The version commit stays; fix' : 'Fix'} the problem and run bun run publish:npm again.`)
}
if (!(await ok($`npm view ${`${name}@${version}`} version`))) {
  console.log('  (npm does not list the new version yet; it can take a minute)')
}

// 7. Push.
if (upstream) {
  step(`Pushing to ${upstream}`)
  await $`git push --follow-tags`
} else {
  console.log(`\n  No upstream branch: push with  git push -u origin ${branch} --follow-tags`)
}
console.log(`\n✔ Released ${name}@${version}`)
