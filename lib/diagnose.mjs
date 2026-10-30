/**
 * 把"这一轮为什么没跑起来"从日志尾部翻成人话。
 *
 * 起因（2026-10-24 一位桌面版用户实测）：
 *   `dsh: NO_ADAPTER: no adapter registered for provider "baomiao-oneapi"`
 *   ⇒ 那一轮 1 秒就 exit 1，报告里只有一行 code=1 ⇒ 用户看不懂，以为插件坏了。
 *
 * 设计约束（刻意压到最小面积）：
 *   · **纯函数**：只吃一段字符串、吐一个对象（或 null），不读文件、不写文件、不抛异常；
 *   · **只在"报告本来该有却没有"时被调用**（跑通的那条路根本不经过它）；
 *   · **认不出来就返回 null** ⇒ 调用方走原来的兜底文案，行为跟以前完全一样。
 *
 * @param {string} tail 这一轮日志的尾部（几百~几千字即可）
 * @returns {{ title: string, body: string, hint?: string } | null}
 */
export function diagnoseRound(tail) {
  const t = String(tail || '')
  if (!t) return null

  // ① 模型提供方没有驱动 —— 最常见的"配了第三方中转、但那个 profile 没装对应插件"
  const noAdapter =
    t.match(/no adapter registered for provider\s+"([^"]+)"/i) ||
    t.match(/NO_ADAPTER[^\n]*provider\s+"([^"]+)"/i)
  if (noAdapter) {
    const p = String(noAdapter[1] || '').trim()
    return {
      title: `这一轮的模型提供方没注册驱动：${p}`,
      hint: 'NO_ADAPTER',
      body: [
        `它一启动就退出了 —— 不是不会刷，而是**那一轮要用的模型提供方 \`${p}\`，在它跑的那个 profile 里没有对应的驱动（adapter）**。`,
        '',
        '提供方的"配置"可能是全局的，但"注册这个提供方的驱动"是**每个 profile 各装各的** —— 主 profile 装了，不等于跑这一轮的 profile 也有。',
        '',
        '**怎么办（任选一种）：**',
        '',
        '1. **最省事**：把那个 profile 的模型改回官方 —— 编辑 `~/.dsh/profiles/headless/cordis.patch.yml`（2.1.0 起是 `bili-duty`），加上：',
        '',
        '   ```yaml',
        '   provider: deepseek-official',
        '   model: deepseek-flash',
        '   ```',
        '',
        '   或者在设置页「刷B站 → 高级 → headless profile」里，指到一个已经配好官方模型的 profile。',
        `2. **继续用 \`${p}\`**：把注册它的那个提供方插件，也装进这个 profile。`,
        '',
        // ⭐ 2026-10-29：2.3.0 起插件会**自己**把当前选中的第三方 provider 插件插进值班轮
        //    （见 index.js 的 externalProviderOverlay）。还看到这句 ⇒ 多半是没走到那条路：
        //    比如「刷B站 → 高级 → headless profile」里手填了别的 profile，或者那个插件不是
        //    我们认得的包名（目前认 dsh-connect-workbuddy）。
        '> 2.3.0 起，值班轮会**自动**把你在主界面选中的那个第三方 provider 插件一起装上 —— 还看到这句，多半是因为「高级 → headless profile」里手填了别的 profile，或者那个 provider 插件不是本插件认得的包。',
        '',
        '> 这类失败是**环境配置**，不是插件坏了。改完不用重装插件，直接再点一次「现在跑一轮」。',
      ].join('\n'),
    }
  }

  // ② 没有可用凭据
  if (/MISSING_CREDENTIAL|missing credential|no api key|Unauthorized|E401|\b401\b/i.test(t)) {
    return {
      title: '这一轮没有可用的模型凭据',
      hint: 'NO_CREDENTIAL',
      body: [
        '它启动后没能拿到模型凭据就退了。',
        '',
        '**怎么办**：去 DSH 设置里确认已登录 / 已填 API key，然后再跑一次。',
        '凭据是宿主那一层的事，插件读不到、也不该替用户填。',
      ].join('\n'),
    }
  }

  // ③ 找不到 dsh（桌面版常见）
  if (/9009|不是内部或外部命令|could not be found|cannot find the file|ENOENT/i.test(t) === true &&
      /dsh/i.test(t)) {
    return {
      title: '这一轮找不到 dsh 可执行文件',
      hint: 'NO_DSH',
      body: [
        '桌面版多半不是 npm 全局安装，PATH 里没有 `dsh`。',
        '',
        '**怎么办**：在设置页把「dsh 路径」指到应用目录里的 `@deepseek-ai/dsh/lib/bin.js`；插件日志里会写出它试过的位置。',
      ].join('\n'),
    }
  }

  // ④ 提示词变量没有值
  // ⚠️ 变量名可能长成 `{{model}}` 这种带花括号的写法 ⇒ 字符类里必须放行 {} $
  const noVar = t.match(/prompt variable\s+"?([\w.{}$-]+)"?\s+has no value/i)
  if (noVar) {
    return {
      title: `提示词变量 \`${noVar[1]}\` 没有值`,
      hint: 'NO_VAR',
      body: [
        '多半是那个 profile 的模型 / 会话没绑好。',
        '',
        '**怎么办**：换一个新会话，或重启一次 DSH 再试。',
      ].join('\n'),
    }
  }

  return null
}
