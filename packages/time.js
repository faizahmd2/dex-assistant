const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc); dayjs.extend(timezone)

const TZ = 'Asia/Kolkata'

module.exports = {
  TZ,
  nowIST: () => dayjs().tz(TZ),
  todayIST: () => dayjs().tz(TZ).format('YYYY-MM-DD'),
  nowForPrompt: () => dayjs().tz(TZ).format('dddd, DD MMM YYYY, HH:mm [IST]'),
  // treat any naive "YYYY-MM-DD HH:mm" from the LLM as IST, store as UTC
  istToUTC: (s) => s ? dayjs.tz(s, TZ).utc().toISOString() : null,
  utcToIST: (s) => s ? dayjs.utc(s).tz(TZ).format('DD MMM, HH:mm') : null,
}