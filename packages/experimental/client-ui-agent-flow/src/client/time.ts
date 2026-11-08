/**
 * Localized duration and relative-time wording shared by this plugin's run
 * surfaces, so the composer card and the results page never disagree about a
 * span or an age.
 * @module
 */

import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** Copy accessor over this plugin's dictionaries. */
export type TimeTranslate = PropsLocale<typeof NS>['t']

/**
 * Format one duration with the locale's own unit words.
 * @param ms - non-negative duration.
 * @param t - dictionary accessor.
 * @returns the localized duration.
 */
export function formatDuration(ms: number, t: TimeTranslate): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return t('duration.lessThanMinute')
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 1) return t('duration.minutes', { n: totalMinutes })
  return t('duration.hours', { n: hours, m: totalMinutes % 60 })
}

/**
 * Format one ISO-8601 start time as a fixed 24-hour clock with seconds, used
 * to separate otherwise identical run options.
 * @param iso - ISO-8601 timestamp.
 * @returns the clock reading, or the raw value when it cannot be parsed.
 */
export function formatClock(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Localize one relative-time bucket.
 * @param bucket - bucket from the shared relative-time helper.
 * @param t - dictionary accessor.
 * @returns the localized trailing label.
 */
export function relativeWord(bucket: ReturnType<typeof relativeTime>, t: TimeTranslate): string {
  switch (bucket.unit) {
    case 'now': return t('time.now')
    case 'minutes': return t('time.minutesAgo', { n: bucket.n })
    case 'hours': return t('time.hoursAgo', { n: bucket.n })
    case 'days': return t('time.daysAgo', { n: bucket.n })
    case 'months': return t('time.monthsAgo', { n: bucket.n })
    case 'years': return t('time.yearsAgo', { n: bucket.n })
  }
}
