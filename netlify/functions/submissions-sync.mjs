/**
 * Netlify Function (레거시) — 공용 핸들러로 위임
 */
import { handleSubmissionsEvent } from '../../server/submissions-handler.mjs'

export const handler = async (event, context) => {
  void context
  return handleSubmissionsEvent(event)
}
