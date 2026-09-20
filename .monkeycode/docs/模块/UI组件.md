# UI 组件

美术优化 P1 引入的公共基础组件，统一视觉规格并减少各屏重复样式。全部从 `useTheme()` 取 `theme` / `fonts` / `tokens`，不引入新依赖。

**位置**: `src/ui/`（`index.js` 统一导出）

## 组件

| 组件 | 导入 | 主要 Props | 说明 |
|------|------|-----------|------|
| `Card` | `src/ui` | `title?`、`titleIcon?`、`right?`、`padded?`、`elevated?`、`style?` | 统一卡片：背景 / 圆角 / 描边 / 可选阴影与标题行 |
| `PrimaryButton` | `src/ui` | `title`、`onPress`、`icon?`、`disabled?`、`loading?`、`small?`、`style?`、`textStyle?` | 主按钮，高度 44、圆角 12，禁用透明度 0.45 |
| `GhostButton` | `src/ui` | 同 `PrimaryButton`（无 `loading`） | 描边次按钮 |
| `IconButton` | `src/ui` | `name`、`onPress`、`size?`（`xs/sm/md/lg/xl`）、`color?`、`disabled?`、`hitSlop?`、`accessibilityLabel?`、`style?` | 纯图标按钮 |
| `Chip` | `src/ui` | `label`、`active?`、`onPress?`、`icon?`、`disabled?`、`style?`、`textStyle?` | 选中/未选中两态胶囊 |
| `FieldLabel` / `FieldHint` | `src/ui` | `children`、`style?` | 表单标签 / 提示文案 |
| `TextField` | `src/ui` | 透传 `TextInput`，另有 `multiline?` | 统一输入框（高度 44、占位色统一） |
| `FieldGroup` | `src/ui` | `label?`、`hint?`、`children`、`style?` | 标签 + 控件 + 提示的组合块 |
| `ListRow` | `src/ui` | `icon?`、`label`、`subtitle?`、`value?`、`right?`、`onPress?`、`showChevron?`、`destructive?`、`disabled?`、`style?` | 统一列表行（最小高度 48） |
| `SheetHeader` | `src/ui` | `title`、`onClose?`、`onBack?`、`closeLabel?` | 弹窗标题行（标题 + 返回/关闭） |
| `TopicButton` | `src/ui` | `onPress`、`label?`（默认「教学」）、`accessibilityLabel?`、`disabled?`、`style?` | 「教学」入口按钮（问号图标 + 文字），各界面统一 |

## 使用约定

- 尺寸一律走 `tokens`（`spacing` / `radius` / `border` / `iconSize` / `metrics` / `elevation`），颜色走 `theme.colors`，字号走 `fonts.scaled`。
- 组件只负责视觉与基础交互，业务逻辑仍留在各屏；`Card` 等不接管数据。
- 新增界面优先复用这些组件，避免再次内联重复样式。
- `Card` 已接入设置页 8 张卡片与角色页 4 张卡片（外层容器替换，内部标题行仍由各屏定义）、动态页动态卡片、记忆页会话卡片（`padded={false}` + `style` 保留横排结构与选中态描边）；这些界面不再保留自有卡片背景/圆角/描边。
- `TopicButton` 已接入设置页（API 配置 / 用户人设 / 对话配图 / 向量记忆）、角色页、记忆页、生图页与动态页；各屏仅通过 `style` 传入外边距。
- `Chip` 已接入生图页尺寸选择（选中态为描边胶囊），替换该页自定义 chip 样式。