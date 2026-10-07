import type { ClientModule, JsonValue } from 'claude-code'

// A transparent region laid over a drawing that cannot take presses (an
// SVG): a click, or Enter or Space once it has the focus, posts `action` to
// the hooks module.

type HitProps = { action: string }

const Hit: ClientModule<JsonValue, true> = (props, surface) => {
  const { action } = props as unknown as HitProps
  if (surface.state === undefined) {
    surface.setState(true)
    surface.onPointer(e => {
      if (e.type === 'down' && (e.button ?? 'left') === 'left') surface.post({ action })
    })
    surface.onKey(k => {
      if (k.key === 'return' || k.key === ' ' || k.key === 'space') surface.post({ action })
    })
  }
  const { Box } = surface.elements
  return <Box width="100%" height="100%" />
}

export default Hit
