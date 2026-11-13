// 2026 State Council holiday notice, mirrored by an official government portal:
// https://zwfw.gansu.gov.cn/chengguan/zwzx/zxtg/art/2025/art_2529408225b9478487a7bd156ff8c37b.html
const holidays = { 2026: [['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']] };
export function deepseekTariff(timestamp = Date.now()) {
  const t = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(t)) throw Error('计费时间无效');
  const local = new Date(t + 8 * 3600000), day = local.toISOString().slice(0,10), year = local.getUTCFullYear();
  const calendarKnown = Boolean(holidays[year]);
  const holiday = (holidays[year] || []).some(([a,b]) => day.slice(5) >= a && day.slice(5) <= b);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes(), weekday = local.getUTCDay();
  const peak = weekday >= 1 && weekday <= 5 && !holiday && ((minute >= 540 && minute < 720) || (minute >= 840 && minute < 1080));
  return { period: peak ? 'standard' : 'discount', peak, holiday, calendarKnown, day };
}
