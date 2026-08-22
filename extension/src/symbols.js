import { lastThursday } from './dates.js';

const MON = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6,
              JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };
const WMON = { '1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
               'O':10,'N':11,'D':12 };
const MONNAME = { 1:'JAN',2:'FEB',3:'MAR',4:'APR',5:'MAY',6:'JUN',
                  7:'JUL',8:'AUG',9:'SEP',10:'OCT',11:'NOV',12:'DEC' };

const RE_FUT     = /^([A-Z&\-]+?)(\d{2})([A-Z]{3})FUT$/;
const RE_MONTHLY = /^([A-Z&\-]+?)(\d{2})([A-Z]{3})(\d+)(CE|PE)$/;
const RE_WEEKLY  = /^([A-Z&\-]+?)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/;

/** @returns {{inst,strike,exp:Date,und,series}|null} */
export function parseSymbol(sym) {
  let m = RE_FUT.exec(sym);
  if (m) {
    const y = 2000 + Number(m[2]);
    const mon = MON[m[3]];
    if (!mon) return null;  // Guard against invalid month code
    return { inst: 'FUT', strike: 0, exp: lastThursday(y, mon),
             und: m[1], series: m[2] + m[3] };
  }

  m = RE_MONTHLY.exec(sym);
  if (m) {
    const y = 2000 + Number(m[2]);
    const mon = MON[m[3]];
    if (!mon) return null;  // Guard against invalid month code
    return { inst: m[5], strike: Number(m[4]), exp: lastThursday(y, mon),
             und: m[1], series: m[2] + m[3] };
  }

  m = RE_WEEKLY.exec(sym);
  if (m) {
    const y = 2000 + Number(m[2]);
    const mo = WMON[m[3]];
    if (!mo) return null;  // Guard against invalid month code
    const dd = Number(m[4]);
    let exp = new Date(Date.UTC(y, mo - 1, dd));
    // Guard against an impossible day such as 31 February.
    if (exp.getUTCMonth() !== mo - 1) exp = lastThursday(y, mo);
    const series = `${m[2]}W-${MONNAME[mo]}${m[4]}`;
    return { inst: m[6], strike: Number(m[5]), exp, und: m[1], series };
  }

  return null;
}
