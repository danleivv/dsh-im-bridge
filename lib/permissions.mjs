/**
 * 权限目录的归一化。
 *
 * 宿主的 catalog 是**对象**：{ defaultPreset, defaultOptions, options }，
 * 每项是 { value, name, description? }——键叫 `value` 而不是 `id`。
 *
 * 之所以单独抽出来：第一次实现把它当数组处理（Object.values），结果只解析出
 * 一个选项，用户看到「权限里只有一个可选」才发现。这种解析函数必须能单测。
 */

/** 把 catalog 变成 [{ id, name, description }]。 */
export function normalizePresets(catalog) {
  if (!catalog) return []
  const list = Array.isArray(catalog)
    ? catalog
    : Array.isArray(catalog.options)
      ? catalog.options
      : Array.isArray(catalog.defaultOptions)
        ? catalog.defaultOptions
        : []
  return list
    .map((item) => {
      if (typeof item === 'string') return { id: item, name: item, description: null }
      const id = item?.value ?? item?.id ?? item?.preset
      if (!id || String(id) === 'undefined') return null
      return {
        id: String(id),
        name: String(item?.name ?? item?.label ?? item?.title ?? id),
        description: item?.description ?? null,
      }
    })
    .filter(Boolean)
}

/** 宿主给的 name 常常就是 id 本身；这种情况返回 null，让上层用自己的标签。 */
export function readableName(preset) {
  if (!preset?.name) return null
  return preset.name === preset.id ? null : preset.name
}
