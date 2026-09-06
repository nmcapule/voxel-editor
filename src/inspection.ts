import { faceViews } from './projections'

export const inspectionViews = [...faceViews, 'iso-front-right', 'iso-front-left', 'iso-back-right', 'iso-back-left'] as const
export type InspectionView = typeof inspectionViews[number]
export const defaultInspectionViews: readonly InspectionView[] = [...faceViews, 'iso-front-right']
