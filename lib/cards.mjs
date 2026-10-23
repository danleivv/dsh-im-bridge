/**
 * 选项卡式卡片：模型选择、权限选择。
 *
 * 为什么用按钮而不是下拉：飞书的下拉（select_static）在手机上要再点一次才展开，
 * 模型和权限都是 3-5 个选项，直接排成按钮就是"选项卡"，一次点击到位。
 *
 * 卡片 2.0 的回调写在 behaviors 里；点击后飞书把 value 原样回传给插件。
 */

/** 一个可点选项。 */
export function optionButton({ label, value, primary = false, badge = null }) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: badge ? label + ' ' + badge : label },
    type: primary ? 'primary' : 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value }],
  }
}

/** 把若干按钮排成竖列（手机上比横排好按）。 */
function column(buttons) {
  return { tag: 'column_set', flex_mode: 'none', columns: buttons.map((button) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [button] })) }
}

/**
 * 模型选项卡。
 *
 * @param {{title: string, subtitle?: string, options: Array<{label: string, value: object, current?: boolean}>, note?: string}} input
 */
export function buildModelCard({ title, subtitle, options, note }) {
  const elements = [{ tag: 'markdown', content: '**' + title + '**' + (subtitle ? '\n' + subtitle : '') }]
  for (const option of options) {
    elements.push(
      column([
        optionButton({
          label: option.label,
          value: { action: 'model.select', ...option.value },
          primary: option.current === true,
          badge: option.current === true ? '（当前）' : null,
        }),
      ]),
    )
  }
  if (note) elements.push({ tag: 'markdown', content: note })
  return { schema: '2.0', config: { wide_screen_mode: true, update_multi: true }, body: { elements } }
}

/**
 * 权限选项卡。
 *
 * @param {{title: string, subtitle?: string, options: Array<{id: string, label: string, description?: string, current?: boolean}>, warn?: string}} input
 */
export function buildPermissionCard({ title, subtitle, options, warn }) {
  const elements = [{ tag: 'markdown', content: '**' + title + '**' + (subtitle ? '\n' + subtitle : '') }]
  for (const option of options) {
    elements.push(
      column([
        optionButton({
          label: option.label,
          value: { action: 'permission.select', preset: option.id },
          primary: option.current === true,
          badge: option.current === true ? '（当前）' : null,
        }),
      ]),
    )
    if (option.description) elements.push({ tag: 'markdown', content: '<font color="grey">' + option.description + '</font>' })
  }
  if (warn) elements.push({ tag: 'markdown', content: warn })
  return { schema: '2.0', config: { wide_screen_mode: true, update_multi: true }, body: { elements } }
}

/** 回调之后把卡片改成"已生效"的样子（复用同一个 message_id）。 */
export function buildResultCard({ title, detail, hint }) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: {
      elements: [
        { tag: 'markdown', content: '**' + title + '**' },
        { tag: 'markdown', content: detail },
        ...(hint ? [{ tag: 'markdown', content: '<font color="grey">' + hint + '</font>' }] : []),
      ],
    },
  }
}
