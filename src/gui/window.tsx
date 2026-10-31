/**
 * opencode-loop-recover — GUI 插件的窗口入口。
 *
 * 在 Settings > Loop Recover 渲染设置页。页面挂载时通过 Ipc 从 main 进程读
 * 配置文件真值（不靠 ctx.options 快照：配置变更后宿主未必立刻重载 GUI 插件）。
 * 控件点击先乐观更新本地 store 再提交；提交失败回滚并 toast。
 */
import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { JSX } from 'solid-js'
import { SettingsPage } from '@opencode/plugin/gui'
import type { Plugin } from '@opencode/plugin/gui'
import { ConfigIpc } from './contract.ts'
import { resolveConfig } from '../config.ts'

type Options = Record<string, unknown>

const setup: Plugin.Setup = (ctx) => {
  const ipc = ctx.main(ConfigIpc)
  const [cfg, setCfg] = createStore(resolveConfig(ctx.options))

  // 配置变更会重载 GUI 插件并重挂页面；ctx.options 此时已是新值，直接渲染，
  // getOptions 再后台校准（网关 Loader 会造成每次写入后的可见闪屏）。
  void ipc
    .getOptions({ signal: ctx.signal })
    .then((options) => setCfg(resolveConfig(options)))
    .catch(() => {})

  const commit = (patch: Options, undo?: () => void) => {
    void ipc.setOptions(patch, { signal: ctx.signal }).catch((cause: unknown) => {
      undo?.()
      ctx.toast.show({ title: ctx.t('settings.saveFailed'), description: String(cause), variant: 'error' })
    })
  }

  const Row = (props: { id: string; title: string; description?: string; children: JSX.Element }) => (
    <div data-component="settings-row">
      <div data-slot="settings-row-copy">
        <div data-slot="settings-row-title">{props.title}</div>
        {props.description ? <div data-slot="settings-row-description">{props.description}</div> : null}
      </div>
      <div data-slot="settings-row-control">
        <div data-action={props.id}>{props.children}</div>
      </div>
    </div>
  )

  const Section = (props: { title: string; children: JSX.Element }) => (
    <section class="settings-section" aria-label={props.title}>
      <h3 class="settings-section-title">{props.title}</h3>
      {props.children}
    </section>
  )

  const Select = (props: {
    id: string
    title: string
    description?: string
    value: () => string
    options: readonly { value: string; label: string }[]
    apply: (value: string) => void
    patch: (value: string) => Options
  }) => (
    <Row id={props.id} title={props.title} description={props.description}>
      <ctx.ui.Menu
        trigger="button"
        label={props.options.find((option) => option.value === props.value())?.label ?? props.value()}
        items={props.options.map((option) => ({
          label: option.label,
          icon: option.value === props.value() ? ('check' as const) : undefined,
          onSelect: () => {
            const previous = props.value()
            props.apply(option.value)
            commit(props.patch(option.value), () => props.apply(previous))
          },
        }))}
      />
    </Row>
  )

  const Toggle = (props: {
    id: string
    title: string
    description?: string
    checked: () => boolean
    apply: (checked: boolean) => void
    patch: (checked: boolean) => Options
  }) => (
    <Row id={props.id} title={props.title} description={props.description}>
      <ctx.ui.Switch
        hideLabel
        label={props.title}
        checked={props.checked()}
        onChange={(checked) => {
          props.apply(checked)
          commit(props.patch(checked), () => props.apply(!checked))
        }}
      />
    </Row>
  )

  const TextField = (props: {
    id: string
    title: string
    description?: string
    value: () => string
    placeholder?: string
    patch: (text: string) => Options
  }) => {
    const [draft, setDraft] = createSignal(props.value())
    // 值没变就不写（Esc 取消后 blur 自然落空，也避免同值写盘触发无谓重载）。
    const commitIfChanged = (text: string) => {
      const trimmed = text.trim()
      if (trimmed === props.value()) return
      commit(props.patch(trimmed), () => setDraft(props.value()))
    }
    return (
      <Row id={props.id} title={props.title} description={`${props.description ?? ''} ${ctx.t('settings.apply.hint')}`.trim()}>
        <div onFocusOut={() => commitIfChanged(draft())} onKeyDown={(e) => e.key === 'Escape' && setDraft(props.value())}>
          <ctx.ui.TextInput
            label={props.title}
            value={draft()}
            placeholder={props.placeholder}
            onInput={setDraft}
            onSubmit={(text) => commitIfChanged(text)}
          />
        </div>
      </Row>
    )
  }

  const NumberField = (props: {
    id: string
    title: string
    description?: string
    value: () => number
    min?: number
    patch: (value: number) => Options
  }) => {
    const [draft, setDraft] = createSignal(String(props.value()))
    const apply = (text: string) => {
      const trimmed = text.trim()
      if (trimmed === String(props.value())) return
      const value = Number(trimmed)
      if (!Number.isFinite(value) || (props.min !== undefined && value < props.min)) {
        ctx.toast.show({ title: ctx.t('settings.invalidNumber'), description: text, variant: 'error' })
        setDraft(String(props.value()))
        return
      }
      commit(props.patch(value), () => setDraft(String(props.value())))
    }
    return (
      <Row id={props.id} title={props.title} description={`${props.description ?? ''} ${ctx.t('settings.apply.hint')}`.trim()}>
        <div onFocusOut={() => apply(draft())} onKeyDown={(e) => e.key === 'Escape' && setDraft(String(props.value()))}>
          <ctx.ui.TextInput label={props.title} value={draft()} placeholder={String(props.value())} onInput={setDraft} onSubmit={apply} />
        </div>
      </Row>
    )
  }

  ctx.add(SettingsPage, {
    id: 'loop-recover',
    icon: 'extensions',
    get title() {
      return ctx.t('settings.title')
    },
    get entries() {
      return [
        { id: 'field-mode', title: ctx.t('field.mode'), description: ctx.t('field.mode.desc') },
        { id: 'field-debuglog', title: ctx.t('field.debugLog'), description: ctx.t('field.debugLog.desc') },
        { id: 'field-maxrescues', title: ctx.t('field.maxRescues'), description: ctx.t('field.maxRescues.desc') },
        { id: 'section-detectors', title: ctx.t('section.detectors') },
        { id: 'section-intent', title: ctx.t('section.intent') },
        { id: 'section-advanced', title: ctx.t('section.advanced') },
      ]
    },
    render: () => (
        <div>
          <Section title={ctx.t('section.basics')}>
            <Select
              id="field-mode"
              title={ctx.t('field.mode')}
              description={ctx.t('field.mode.desc')}
              value={() => cfg.mode}
              options={[
                { value: 'rescue', label: ctx.t('mode.rescue') },
                { value: 'cut', label: ctx.t('mode.cut') },
                { value: 'observe', label: ctx.t('mode.observe') },
              ]}
              apply={(value) => setCfg('mode', value as typeof cfg.mode)}
              patch={(mode) => ({ mode })}
            />
            <Select
              id="field-language"
              title={ctx.t('field.language')}
              description={ctx.t('field.language.desc')}
              value={() => cfg.language}
              options={[
                { value: 'auto', label: ctx.t('language.auto') },
                { value: 'zh', label: ctx.t('language.zh') },
                { value: 'en', label: ctx.t('language.en') },
              ]}
              apply={(value) => setCfg('language', value as typeof cfg.language)}
              patch={(language) => ({ language })}
            />
            <Toggle
              id="field-keeplanguage"
              title={ctx.t('field.keepLanguage')}
              description={ctx.t('field.keepLanguage.desc')}
              checked={() => cfg.keepLanguage}
              apply={(value) => setCfg('keepLanguage', value)}
              patch={(keepLanguage) => ({ keepLanguage })}
            />
            <TextField
              id="field-debuglog"
              title={ctx.t('field.debugLog')}
              description={ctx.t('field.debugLog.desc')}
              value={() => (cfg.debugLog === false ? '' : cfg.debugLog)}
              placeholder="/tmp/loop-recover.log"
              patch={(debugLog) => ({ debugLog: debugLog === '' ? null : debugLog })}
            />
          </Section>

          <Section title={ctx.t('section.rescue')}>
            <NumberField
              id="field-maxrescues"
              title={ctx.t('field.maxRescues')}
              description={ctx.t('field.maxRescues.desc')}
              value={() => cfg.maxRescues}
              min={1}
              patch={(maxRescues) => ({ maxRescues })}
            />
            <NumberField
              id="field-tempbump"
              title={ctx.t('field.temperatureBump')}
              description={ctx.t('field.temperatureBump.desc')}
              value={() => cfg.temperatureBump}
              min={0}
              patch={(temperatureBump) => ({ temperatureBump })}
            />
          </Section>

          <Section title={ctx.t('section.detectors')}>
            <div data-action="section-detectors" />
            {(['periodic', 'ngram', 'anchor', 'charrun', 'pool', 'intent'] as const).map((key) => (
              <Toggle
                id={`detector-${key}`}
                title={ctx.t(`detector.${key}`)}
                description={ctx.t(`detector.${key}.desc`)}
                checked={() => cfg.detectors[key]}
                apply={(value) => setCfg('detectors', key, value)}
                patch={(value) => ({ detectors: { [key]: value } })}
              />
            ))}
          </Section>

          <Section title={ctx.t('section.intent')}>
            <div data-action="section-intent" />
            <TextField
              id="intent-toolpatterns"
              title={ctx.t('intent.toolPatterns')}
              description={ctx.t('intent.toolPatterns.desc')}
              value={() => cfg.intent.toolPatterns.join(', ')}
              placeholder="web_search"
              patch={(text) => ({
                intent: {
                  toolPatterns:
                    text === ''
                      ? null
                      : text
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                },
              })}
            />
            <NumberField id="intent-stalllimit" title={ctx.t('intent.stallLimit')} description={ctx.t('intent.stallLimit.desc')} value={() => cfg.intent.stallLimit} min={1} patch={(stallLimit) => ({ intent: { stallLimit } })} />
            <NumberField id="intent-novelty" title={ctx.t('intent.noveltyThreshold')} description={ctx.t('intent.noveltyThreshold.desc')} value={() => cfg.intent.noveltyThreshold} min={0} patch={(noveltyThreshold) => ({ intent: { noveltyThreshold } })} />
            <NumberField id="intent-similarity" title={ctx.t('intent.similarityThreshold')} description={ctx.t('intent.similarityThreshold.desc')} value={() => cfg.intent.similarityThreshold} min={0} patch={(similarityThreshold) => ({ intent: { similarityThreshold } })} />
            <NumberField id="intent-historysize" title={ctx.t('intent.historySize')} description={ctx.t('intent.historySize.desc')} value={() => cfg.intent.historySize} min={1} patch={(historySize) => ({ intent: { historySize } })} />
          </Section>

          <Section title={ctx.t('section.advanced')}>
            <div data-action="section-advanced" />
            <NumberField id="th-minperiod" title={ctx.t('threshold.minPeriod')} value={() => cfg.detector.minPeriod} min={1} patch={(minPeriod) => ({ thresholds: { minPeriod } })} />
            <NumberField id="th-maxperiod" title={ctx.t('threshold.maxPeriod')} value={() => cfg.detector.maxPeriod} min={1} patch={(maxPeriod) => ({ thresholds: { maxPeriod } })} />
            <NumberField id="th-periodrepeats" title={ctx.t('threshold.periodRepeats')} description={ctx.t('threshold.periodRepeats.desc')} value={() => cfg.detector.periodRepeats} min={2} patch={(periodRepeats) => ({ thresholds: { periodRepeats } })} />
            <NumberField id="th-runminchars" title={ctx.t('threshold.runMinChars')} description={ctx.t('threshold.runMinChars.desc')} value={() => cfg.detector.runMinChars} min={16} patch={(runMinChars) => ({ thresholds: { runMinChars } })} />
            <NumberField id="th-ngramsize" title={ctx.t('threshold.ngramSize')} value={() => cfg.detector.ngramSize} min={8} patch={(ngramSize) => ({ thresholds: { ngramSize } })} />
            <NumberField id="th-ngramrepeats" title={ctx.t('threshold.ngramRepeats')} value={() => cfg.detector.ngramRepeats} min={2} patch={(ngramRepeats) => ({ thresholds: { ngramRepeats } })} />
            <NumberField id="th-ngramwindow" title={ctx.t('threshold.ngramWindow')} value={() => cfg.detector.ngramWindow} min={64} patch={(ngramWindow) => ({ thresholds: { ngramWindow } })} />
            <NumberField id="th-ngramstep" title={ctx.t('threshold.ngramStep')} value={() => cfg.detector.ngramStep} min={1} patch={(ngramStep) => ({ thresholds: { ngramStep } })} />
            <NumberField id="th-anchorsize" title={ctx.t('threshold.anchorSize')} value={() => cfg.detector.anchorSize} min={16} patch={(anchorSize) => ({ thresholds: { anchorSize } })} />
            <NumberField id="th-anchorwindow" title={ctx.t('threshold.anchorWindow')} value={() => cfg.detector.anchorWindow} min={64} patch={(anchorWindow) => ({ thresholds: { anchorWindow } })} />
            <NumberField id="th-mindistinct" title={ctx.t('threshold.minDistinctChars')} description={ctx.t('threshold.minDistinctChars.desc')} value={() => cfg.detector.minDistinctChars} min={1} patch={(minDistinctChars) => ({ thresholds: { minDistinctChars } })} />
            <NumberField id="th-minsubstantive" title={ctx.t('threshold.minSubstantiveRatio')} description={ctx.t('threshold.minSubstantiveRatio.desc')} value={() => cfg.detector.minSubstantiveRatio} min={0} patch={(minSubstantiveRatio) => ({ thresholds: { minSubstantiveRatio } })} />
            <NumberField id="th-poolwindow" title={ctx.t('threshold.poolWindow')} value={() => cfg.detector.poolWindow} min={64} patch={(poolWindow) => ({ thresholds: { poolWindow } })} />
            <NumberField id="th-poolunitmin" title={ctx.t('threshold.poolUnitMinChars')} value={() => cfg.detector.poolUnitMinChars} min={2} patch={(poolUnitMinChars) => ({ thresholds: { poolUnitMinChars } })} />
            <NumberField id="th-poolminrepeats" title={ctx.t('threshold.poolMinRepeats')} value={() => cfg.detector.poolMinRepeats} min={2} patch={(poolMinRepeats) => ({ thresholds: { poolMinRepeats } })} />
          </Section>
        </div>
    ),
  })
}

export default setup
