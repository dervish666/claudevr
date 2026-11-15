// The character buttons: a row under the talk iris, one per configured
// character and OPERATOR, so a character can be changed with the trigger as
// well as by voice. The lit one is on, in its own accent. A press waits for
// the bridge (the label says so), and a refusal shows as a line under the row.

import { memo } from 'react'
import { Container, Text } from '@react-three/uikit'
import type { Voice } from '../hud/voice/useVoice.ts'
import { IRIS_R, IRIS_Y, RING_Z } from './Core.tsx'
import { fit } from './text.ts'
import { C, FONTS, rgba, shade } from './theme.ts'
import { log } from './telemetry.ts'

const MM = 0.001
/** The row's top edge: under the iris and its backing disc, with a little air. */
export const CHAR_ROW_TOP = IRIS_Y - IRIS_R - 0.035
/** Wide enough for three buttons; kept inside about 12 degrees either side, clear of the settings panel to the right. */
const ROW_W = 540

export const CharacterButtons = memo(function CharacterButtons({ voice }: { voice: Voice }) {
  const { characters, character, characterPending, characterError } = voice
  if (!characters.length) return null
  const current = character?.name ?? null
  const buttons = [...characters.map(c => ({ name: c.name as string | null, label: c.name.toUpperCase(), accent: c.accent ?? C.cyan })), { name: null, label: 'OPERATOR', accent: C.cyan }]
  const pressed = (name: string | null) => {
    if (voice.characterPending) return
    log('character-button', { name })
    voice.chooseCharacter(name)
  }
  // The root is rebuilt (its key) when the buttons or the error line come or go: children
  // added to or removed from a live uikit root leave ghost text behind.
  const shape = `${buttons.map(b => b.name ?? '-').join('|')}:${characterError ? 'err' : ''}`
  return (
    <group position={[0, CHAR_ROW_TOP, RING_Z + 0.03]}>
      <Container key={shape} pixelSize={MM} fontFamilies={FONTS} anchorY="top" flexDirection="column" alignItems="center" gap={6} width={ROW_W}>
        <Container flexDirection="row" gap={8} width={ROW_W} justifyContent="center">
          {buttons.map(b => {
            const on = b.name === current
            const pending = characterPending !== null && characterPending.name === b.name
            return (
              <Container
                key={b.name ?? 'operator'}
                flexGrow={1}
                flexBasis={0}
                height={52}
                borderRadius={8}
                borderWidth={3}
                borderColor={on || pending ? b.accent : C.cyanFaint}
                backgroundColor={on ? shade(b.accent, 0.72) : rgba(8, 12, 15, 0.95)}
                hover={{ borderColor: C.white }}
                justifyContent="center"
                alignItems="center"
                onClick={e => {
                  e.stopPropagation()
                  pressed(b.name)
                }}
              >
                <Text fontFamily="rajdhani" fontWeight="bold" fontSize={22} color={on ? C.white : pending ? b.accent : C.muted} wordBreak="keep-all">
                  {fit(pending ? `${b.label}…` : b.label, 'rajdhani-700')}
                </Text>
              </Container>
            )
          })}
        </Container>
        {characterError && (
          <Container paddingX={10} paddingY={4} borderRadius={6} backgroundColor={rgba(40, 8, 8, 0.92)} maxWidth={ROW_W}>
            <Text fontFamily="inter" fontSize={15} color={C.red}>
              {fit(characterError.length > 110 ? `${characterError.slice(0, 108)}…` : characterError)}
            </Text>
          </Container>
        )}
      </Container>
    </group>
  )
})
