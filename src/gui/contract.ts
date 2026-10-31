import { Schema } from 'effect'
import { Ipc } from '@opencode/plugin/gui'

/**
 * 设置页 ↔ main 进程的桥：窗口提交 options 补丁，main 写回全局 opencode.json(c)。
 * patch 语义见 config-patch.ts：嵌套对象一级浅合并，null 删除该键回落默认。
 */
export const ConfigIpc = Ipc.define({
  id: 'loop-recover.config',
  methods: {
    /** 合并一段 options 补丁到本插件的全局配置 entry，写盘成功后由宿主重载插件。 */
    setOptions: { input: Schema.Record(Schema.String, Schema.Unknown) },
    /** 读出本插件当前的全局 options（设置页以此渲染真值，不依赖插件重载刷新 ctx.options）。 */
    getOptions: { output: Schema.Record(Schema.String, Schema.Unknown) },
    /** 当前生效的全局配置文件绝对路径（设置页展示用）。 */
    configPath: { output: Schema.String },
  },
})
