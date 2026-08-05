export type MapOverlayState = 'collapsed' | 'browsing' | 'selected'

export type MapOverlayAction =
  | { type: 'open' }
  | { type: 'select' }
  | { type: 'dismiss' }

export function mapOverlayReducer(_: MapOverlayState, action: MapOverlayAction): MapOverlayState {
  switch (action.type) {
    case 'open':
      return 'browsing'
    case 'select':
      return 'selected'
    case 'dismiss':
      return 'collapsed'
  }
}
