#!/usr/bin/env node
/**
 * tools/sync.mjs —— 本地 checkout ↔ fork 仓库 的同步器
 * ============================================================================
 * 用法：
 *   node tools/sync.mjs                 # 全部：提交 → 推送 → 合并上游
 *   node tools/sync.mjs --status        # 只看状态，什么都不动
 *   node tools/sync.mjs --commit-only   # 只提交 + 推送，不碰上游
 *   node tools/sync.mjs --pull-only     # 只合并上游，不提交本地
 *   node tools/sync.mjs --msg "…"       # 指定提交信息
 *   node tools/sync.mjs --dry-run       # 说清要做什么，但不执行任何 git 写操作
 *
 * 它做的事（按顺序，任一步失败就停，绝不硬来）：
 *   1. 检查工作区：有改动就先 `git add -A && git commit`
 *      —— 提交信息默认自动生成（按改了哪些文件给一句人话）
 *   2. `git push fork main`（本地领先才推）+ 推 tag
 *   3. `git fetch upstream` → 有更新就 `git merge upstream/main`
 *      —— 冲突时**不自动解决**，把冲突文件列出来、`git merge --abort`，退出码 2
 *
 * 为什么不用 hook 自动提交：这个目录是**正在运行的插件本体**（desktop profile
 * 是 `link:` 指过来的）。挂 post-commit / post-merge 钩子会在 git 自己写 ref 的
 * 过程中再起一次 git，容易撞锁、也容易把半成品状态提交上去。手动/定时跑一个
 * 显式脚本，比隐式钩子安全得多，而且**看得见它做了什么** ✓
 *
 * 冲突策略（对齐用户要求「不冲突的话就可以直接合并」）：
 *   能自动合就合；冲突就**原样停在合并前**，把两侧改了什么打印出来，让人（或
 *   AI）来决定。绝不 `-X ours` 或 `-X theirs` —— 那会把上游的修复或我们自己的
 *   修复悄悄丢掉。
 * ============================================================================
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const UPSTREAM = 'upstream/main'
const REMOTE = 'fork'
const BRANCH = 'main'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const STATUS_ONLY = flag('--status')
const DRY = flag('--dry-run')
const COMMIT_ONLY = flag('--commit-only')
const PULL_ONLY = flag('--pull-only')
const MSG = value('--msg')

const out = (s = '') => process.stdout.write(s + '\n')
const step = (n, s) => out(`\n=== ${n} · ${s} ===`)

/** 跑一条 git 命令；失败时把 stderr 一起抛出来，别吞掉 */
function git(args, { allowFail = false, env = {} } = {}) {
  try {
    const r = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    })
    return r.trim()
  } catch (e) {
    if (allowFail) return ''
    const err = String((e && e.stderr) || e.message || e).trim()
    throw new Error(`git ${args.join(' ')}\n${err}`)
  }
}

function hasChanges() {
  return git(['status', '--porcelain']).length > 0
}

/** 按改动文件给一句人话提交信息（用户要「改完直接同步」，别每次都手写） */
function autoMessage() {
  const raw = git(['status', '--porcelain'])
  const files = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
  const areas = []
  const add = (k) => { if (!areas.includes(k)) areas.push(k) }
  for (const f of files) {
    if (f === 'index.js') add('host 半端')
    else if (f === 'client.js') add('设置页')
    else if (f.startsWith('lib/')) add('lib')
    else if (f.startsWith('prompts/')) add('值班提示词')
    else if (f.startsWith('test/')) add('测试')
    else if (f.startsWith('tools/')) add('工具')
    else if (f.startsWith('vendor/')) add('内置 MCP')
    else if (f === 'package.json' || f === 'CHANGELOG.md') add('发版')
    else if (f.endsWith('.md')) add('文档')
    else add('其它')
  }
  const ver = readVersion()
  const list = files.slice(0, 6).join(', ') + (files.length > 6 ? ` 等 ${files.length} 个文件` : '')
  return `sync(${ver}): 改 ${areas.join(' / ')} —— ${list}`
}

function readVersion() {
  try {
    const p = JSON.parse(git(['show', 'HEAD:package.json']) || '{}')
    return p.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

function currentVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

function aheadBehind() {
  const r = git(['rev-list', '--left-right', '--count', `${UPSTREAM}...HEAD`], { allowFail: true })
  if (!r) return null
  const [behind, ahead] = r.split(/\s+/).map(Number)
  return { behind, ahead }
}

function report() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || '?'
  const head = git(['rev-parse', '--short', 'HEAD'], { allowFail: true }) || '?'
  const tracking = git(['rev-parse', '--short', `${REMOTE}/${BRANCH}`], { allowFail: true }) || '(没拉到)'
  const dirty = hasChanges()
  const ab = aheadBehind()
  const ver = currentVersion()

  out(`仓库    ${ROOT}`)
  out(`分支    ${branch} @ ${head}    版本 ${ver}`)
  out(`跟踪    ${REMOTE}/${BRANCH} @ ${tracking}`)
  out(`工作区  ${dirty ? '有未提交改动' : '干净'}`)
  if (ab) {
    out(`对上游  ${UPSTREAM}：落后 ${ab.behind} 个提交，领先 ${ab.ahead} 个提交`)
    if (ab.behind > 0) {
      out('')
      out('上游有更新：')
      const log = git(['log', '--oneline', `HEAD..${UPSTREAM}`], { allowFail: true })
      for (const line of log.split('\n').filter(Boolean).slice(0, 20)) out('  ' + line)
    }
  }
  const tags = git(['tag', '--points-at', 'HEAD'], { allowFail: true })
  if (tags) out(`HEAD 上的 tag：${tags.split('\n').join(', ')}`)
  return { branch, head, dirty, ab }
}

// ---------------------------------------------------------------- 主流程
const state = report()
if (STATUS_ONLY) process.exit(0)

if (state.branch !== BRANCH) {
  out(`\n✗ 当前不在 ${BRANCH} 分支（在 ${state.branch}）—— 为了不误推，先停下。`)
  process.exit(2)
}

let committed = false
let pushed = false
let merged = false

// 1) 提交
if (!PULL_ONLY) {
  step(1, '提交本地改动')
  if (!hasChanges()) {
    out('工作区干净，没什么要提交的 ✓')
  } else {
    const msg = MSG || autoMessage()
    out(`提交信息：${msg}`)
    if (DRY) {
      out('（--dry-run：不真的提交）')
    } else {
      git(['add', '-A'])
      git(['commit', '-m', msg])
      committed = true
      out('已提交 ✓')
    }
  }
}

// 2) 推送
if (!PULL_ONLY) {
  step(2, `推送到 ${REMOTE}/${BRANCH}`)
  const local = git(['rev-parse', 'HEAD'], { allowFail: true })
  const remote = git(['rev-parse', `${REMOTE}/${BRANCH}`], { allowFail: true })
  if (!local) {
    out('拿不到本地 HEAD，跳过推送。')
  } else if (remote === local) {
    out(`${REMOTE}/${BRANCH} 已经和本地一样，不用推 ✓`)
  } else if (DRY) {
    out(`（--dry-run：会推 ${local.slice(0, 7)} 到 ${REMOTE}/${BRANCH}）`)
  } else {
    git(['push', REMOTE, `${BRANCH}:${BRANCH}`])
    pushed = true
    out(`已推送 ${local.slice(0, 7)} → ${REMOTE}/${BRANCH} ✓`)
  }
  // tag 一起推（发版号就是靠 tag 落在远端）
  const tags = git(['tag', '--points-at', 'HEAD'], { allowFail: true })
  if (tags && !DRY) {
    for (const t of tags.split('\n').filter(Boolean)) {
      const onRemote = git(['ls-remote', '--tags', REMOTE, `refs/tags/${t}`], { allowFail: true })
      if (!onRemote) {
        git(['push', REMOTE, `refs/tags/${t}`])
        out(`已推送 tag ${t} ✓`)
      }
    }
  }
}

// 3) 合并上游
if (!COMMIT_ONLY) {
  step(3, `合并上游 ${UPSTREAM}`)
  if (DRY) {
    out('（--dry-run：不 fetch）')
  } else {
    git(['fetch', 'upstream', '--tags'])
  }
  const ab = aheadBehind()
  if (!ab) {
    out('拿不到上游分支，跳过。')
  } else if (ab.behind === 0) {
    out('上游没有新提交 ✓')
  } else {
    out(`上游有 ${ab.behind} 个新提交，开始合并…`)
    if (DRY) {
      out('（--dry-run：不真的合并）')
    } else {
      const r = git(['merge', '--no-edit', UPSTREAM], { allowFail: true })
      if (r) {
        merged = true
        out('合并成功 ✓')
        out(r.split('\n').slice(0, 8).join('\n'))
      } else {
        const conflicted = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true })
        out('')
        out('✗ 有冲突，已停在合并中间。冲突文件：')
        for (const f of conflicted.split('\n').filter(Boolean)) out('  ' + f)
        out('')
        out('两侧各改了什么：')
        const upstreamLog = git(['log', '--oneline', `HEAD..${UPSTREAM}`], { allowFail: true })
        for (const line of upstreamLog.split('\n').filter(Boolean).slice(0, 10)) out('  上游 ' + line)
        out('')
        out('自动合并没法两全 —— 需要人来定夺。可选：')
        out('  保住我们的改动： git checkout --ours <file> && git add <file> && git commit')
        out('  接受上游的：     git checkout --theirs <file> && git add <file> && git commit')
        out('  算了不合并：     git merge --abort')
        process.exitCode = 2
      }
    }
  }
}

// 4) 合并后把结果推上去（否则远端还是旧状态）
if (merged && !DRY) {
  step(4, '推送合并结果')
  const local = git(['rev-parse', 'HEAD'], { allowFail: true })
  const remote = git(['rev-parse', `${REMOTE}/${BRANCH}`], { allowFail: true })
  if (local !== remote) {
    git(['push', REMOTE, `${BRANCH}:${BRANCH}`])
    out(`已推送合并结果 ${local.slice(0, 7)} → ${REMOTE}/${BRANCH} ✓`)
  } else {
    out('远端已是最新 ✓')
  }
}

if (!process.exitCode) out('\n全部完成 ✓')
