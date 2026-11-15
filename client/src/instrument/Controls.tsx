// The settings panel: low, to the right, tilted up like a desk strip, with
// big labelled buttons. Sam operates it without a manual, so every toggle
// names itself and shows which option is on. MINIMISE folds it to a strip
// that keeps only the way back and the way out.

import { memo } from 'react'
import { Container, Text } from '@react-three/uikit'
import type { Signal } from '@preact/signals-core'
import { setSetting, useSettings, type Settings } from './settings.ts'
import { C, DEG, FONTS, rgba } from './theme.ts'
import { log } from './telemetry.ts'

const MM = 0.001

function Option<K extends keyof Settings>({ k, value, label }: { k: K; value: Settings[K]; label: string }) {
  const s = useSettings()
  const on = s[k] === value
  return (
    <Container
      flexGrow={1}
      height={58}
      borderRadius={8}
      borderWidth={3}
      borderColor={on ? C.cyan : C.cyanFaint}
      backgroundColor={on ? rgba(20, 70, 90, 0.96) : rgba(8, 12, 15, 0.95)}
      hover={{ borderColor: C.white }}
      justifyContent="center"
      alignItems="center"
      onClick={e => {
        e.stopPropagation()
        if (on) return
        setSetting(k, value)
        log('toggle', { [k]: value, settings: { ...s, [k]: value } })
      }}
    >
      <Text fontFamily="rajdhani" fontWeight="bold" fontSize={24} color={on ? C.white : C.muted}>
        {label}
      </Text>
    </Container>
  )
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Container flexDirection="row" alignItems="center" gap={8}>
      <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.muted} width={104}>
        {title}
      </Text>
      {children}
    </Container>
  )
}

function Action({ label, colour, onClick }: { label: string; colour: string; onClick: () => void }) {
  return (
    <Container
      flexGrow={1}
      height={58}
      borderRadius={8}
      borderWidth={3}
      borderColor={colour}
      backgroundColor={rgba(8, 12, 15, 0.95)}
      hover={{ backgroundColor: rgba(30, 45, 55, 0.98) }}
      justifyContent="center"
      alignItems="center"
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Text fontFamily="rajdhani" fontWeight="bold" fontSize={24} color={colour}>
        {label}
      </Text>
    </Container>
  )
}

export interface ControlsProps {
  /** "LAYER (compositor)", "LAYER: fallback mesh", "PREVIEW: mesh only". */
  streamNote: string
  perf: Signal<string>
  mic: Signal<string>
  preview: boolean
  onRecenter: () => void
  onFakeNeed: () => void
  onExit: () => void
}

/** Memoised: the callbacks it is handed are stable, so it renders again only when a toggle or the stream note changes. */
export const Controls = memo(function Controls({ streamNote, perf, mic, preview, onRecenter, onFakeNeed, onExit }: ControlsProps) {
  const minimised = useSettings().minimised
  const fold = (to: boolean) => {
    setSetting('minimised', to)
    log('toggle', { minimised: to })
  }
  // Folded: a strip where the panel's top edge was. The two forms are separate
  // roots (the key), because uikit leaves stray text behind when children come
  // and go inside a root that stays alive.
  if (minimised) {
    return (
      <group position={[0.5, -0.5, -0.78]} rotation={[-38 * DEG, -30 * DEG, 0, 'YXZ']}>
        <Container key="folded" pixelSize={MM} fontFamilies={FONTS} flexDirection="row" gap={8} width={330} padding={10} borderRadius={10} borderWidth={2} borderColor={C.cyanDim} backgroundColor={rgba(6, 9, 11, 0.94)}>
          <Action label="SETTINGS" colour={C.cyan} onClick={() => fold(false)} />
          <Action label={preview ? 'BACK TO 2D' : 'EXIT'} colour={C.red} onClick={onExit} />
        </Container>
      </group>
    )
  }
  // y is low enough to clear the bottom tile row's age line on the right wing.
  return (
    <group position={[0.5, -0.66, -0.78]} rotation={[-38 * DEG, -30 * DEG, 0, 'YXZ']}>
      <Container key="open" pixelSize={MM} fontFamilies={FONTS} flexDirection="column" gap={8} width={560} padding={16} borderRadius={10} borderWidth={2} borderColor={C.cyanDim} backgroundColor={rgba(6, 9, 11, 0.94)}>
        <Container flexDirection="row" alignItems="center" gap={10}>
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={24} color={C.cyan}>
            SETTINGS
          </Text>
          <Text fontFamily="inter" fontSize={15} color={C.muted} flexShrink={1} flexGrow={1}>
            {streamNote}
          </Text>
          <Container
            height={40}
            paddingX={14}
            borderRadius={8}
            borderWidth={3}
            borderColor={C.cyanFaint}
            backgroundColor={rgba(8, 12, 15, 0.95)}
            hover={{ borderColor: C.white }}
            justifyContent="center"
            alignItems="center"
            flexShrink={0}
            onClick={e => {
              e.stopPropagation()
              fold(true)
            }}
          >
            <Text fontFamily="rajdhani" fontWeight="bold" fontSize={20} color={C.muted}>
              MINIMISE
            </Text>
          </Container>
        </Container>
        <Row title="STREAM">
          <Option k="stream" value="layer" label="LAYER" />
          <Option k="stream" value="mesh" label="MESH" />
        </Row>
        <Row title="GLOW">
          <Option k="glow" value={true} label="ON" />
          <Option k="glow" value={false} label="OFF" />
        </Row>
        <Row title="DIMMER">
          <Option k="dimmer" value={0} label="0%" />
          <Option k="dimmer" value={0.3} label="30%" />
          <Option k="dimmer" value={0.5} label="50%" />
        </Row>
        <Row title="ROTATION">
          <Option k="rotation" value={true} label="ON" />
          <Option k="rotation" value={false} label="OFF" />
        </Row>
        <Row title="PLATE">
          <Option k="plate" value={0.92} label="92%" />
          <Option k="plate" value={0.7} label="70%" />
        </Row>
        <Container flexDirection="row" gap={8} marginTop={4}>
          <Action label="RECENTER" colour={C.cyan} onClick={onRecenter} />
          <Action label="FAKE A NEED" colour={C.purple} onClick={onFakeNeed} />
          <Action label={preview ? 'BACK TO 2D' : 'EXIT'} colour={C.red} onClick={onExit} />
        </Container>
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={C.muted}>
          {perf}
        </Text>
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={C.muted}>
          {mic}
        </Text>
      </Container>
    </group>
  )
})
