const DAY_LENGTH = [6.5, 7.5, 9, 12.8, 13.9, 15, 15, 14, 12, 10.5, 9, 7.5];
const DAY_LENGTH_DC = [6.5, 7.5, 9, 12.8, 13.9, 15, 16, 14, 12, 10.5, 9, 8];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function calculateFFMC(temp, rh, wind, rain, prev = 85) {
  const ffmc0 = clamp(prev, 0, 101);
  let mo = 147.2 * (101 - ffmc0) / (59.5 + ffmc0);
  if (rain > 0.5) {
    const rf = rain - 0.5;
    const term = 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf));
    if (mo > 150) {
      mo = mo + term + 0.0015 * (mo - 150) * (mo - 150) * Math.sqrt(rf);
    } else {
      mo = mo + term;
    }
    if (mo > 250) mo = 250;
  }

  const rhClamped = clamp(rh, 0, 100);
  const ed = 0.942 * Math.pow(rhClamped, 0.679) + 11 * Math.exp((rhClamped - 100) / 10) + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rhClamped));
  const ew = 0.618 * Math.pow(rhClamped, 0.753) + 10 * Math.exp((rhClamped - 100) / 10) + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rhClamped));

  let m;
  if (mo < ed) {
    const kd = 0.424 * (1 - Math.pow(rhClamped / 100, 1.7)) + 0.0694 * Math.sqrt(Math.max(wind, 0)) * (1 - Math.pow(rhClamped / 100, 8));
    const kw = kd * 0.581 * Math.exp(0.0365 * temp);
    m = ed - (ed - mo) * Math.pow(10, -kw);
  } else {
    const rhFactor = (100 - rhClamped) / 100;
    const kw1 = 0.424 * (1 - Math.pow(rhFactor, 1.7)) + 0.0694 * Math.sqrt(Math.max(wind, 0)) * (1 - Math.pow(rhFactor, 8));
    const kw = kw1 * 0.581 * Math.exp(0.0365 * temp);
    m = ew + (mo - ew) * Math.pow(10, -kw);
  }

  const ffmc = (59.5 * (250 - m)) / (147.2 + m);
  return clamp(ffmc, 0, 101);
}

function calculateDMC(temp, rh, rain, month, prev = 6) {
  const monthIdx = clamp((month || 1) - 1, 0, 11);
  const L = DAY_LENGTH[monthIdx];
  const rhClamped = clamp(rh, 0, 100);
  let dmc = prev;

  if (rain > 1.5) {
    const re = 0.92 * rain - 1.27;
    const mo = 20 + Math.exp(5.6348 - prev / 43.43);
    let b;
    if (prev <= 33) {
      b = 100 / (0.5 + 0.3 * prev);
    } else if (prev <= 65) {
      b = 14 - 1.3 * Math.log(prev);
    } else {
      b = 6.2 * Math.log(prev) - 17.2;
    }
    const mr = mo + 1000 * re / (48.77 + b * re);
    const newDmc = 43.43 * (5.6348 - Math.log(Math.max(0.0001, mr - 20)));
    dmc = Math.max(0, newDmc);
  }

  const k = 1.894 * (temp + 1.1) * (100 - rhClamped) * L * 1e-6;
  return dmc + Math.max(0, k);
}

function calculateDC(temp, rain, month, prev = 15) {
  const monthIdx = clamp((month || 1) - 1, 0, 11);
  const L = DAY_LENGTH_DC[monthIdx];
  let dc = prev;

  if (rain > 2.8) {
    const rd = 0.83 * rain - 1.27;
    const qo = 800 * Math.exp(-prev / 400);
    const qr = qo + 3.937 * rd;
    if (qr > 0) {
      const newDc = 400 * Math.log(800 / qr);
      dc = Math.max(0, newDc);
    } else {
      dc = 0;
    }
  }

  const v = 0.36 * (temp + 2.8) + L;
  return dc + Math.max(0, v);
}

function calculateISI(ffmc, wind) {
  const m = 147.2 * (101 - ffmc) / (59.5 + ffmc);
  const fF = 91.9 * Math.exp(-0.1386 * m) * (1 + Math.pow(m, 5.31) / 4.93e7);
  const fW = Math.exp(0.05039 * wind);
  return fF * fW;
}

function calculateBUI(dmc, dc) {
  if (dmc <= 0) return 0;
  if (dc <= 0) return dmc;

  if (dmc <= 0.4 * dc) {
    return (0.8 * dmc * dc) / (dmc + 0.4 * dc);
  }

  const numerator = 0.92 + Math.pow(0.0114 * dmc, 1.7);
  const bui = dmc - (1 - (0.8 * dc) / (dmc + 0.4 * dc)) * numerator;
  return Math.max(0, bui);
}

function calculateFWI(isi, bui) {
  if (bui <= 0) {
    return Math.max(0, isi * 0.1);
  }
  const fD = bui <= 80
    ? 0.626 * Math.pow(bui, 0.809) + 2
    : 1000 / (25 + 108.64 * Math.exp(-0.023 * bui));
  const b = 0.1 * isi * fD;
  if (b <= 1) return b;
  return Math.exp(2.72 * Math.pow(0.434 * Math.log(b), 0.647));
}

function classifyFWI(fwi) {
  if (fwi < 5) return "low";
  if (fwi < 12) return "moderate";
  if (fwi < 21) return "high";
  if (fwi < 38) return "very-high";
  return "extreme";
}

function computeFWI({ temperature, relativeHumidity, windSpeed, rain, month, previousCodes }) {
  const windKmH = Math.max(0, windSpeed) * 3.6;
  const rainMm = Math.max(0, rain);

  const prev = {
    ffmc: previousCodes?.ffmc ?? 85,
    dmc: previousCodes?.dmc ?? 6,
    dc: previousCodes?.dc ?? 15
  };

  const ffmc = calculateFFMC(temperature, relativeHumidity, windKmH, rainMm, prev.ffmc);
  const dmc = calculateDMC(temperature, relativeHumidity, rainMm, month, prev.dmc);
  const dc = calculateDC(temperature, rainMm, month, prev.dc);
  const isi = calculateISI(ffmc, windKmH);
  const bui = calculateBUI(dmc, dc);
  const fwi = calculateFWI(isi, bui);

  return {
    ffmc: Number(ffmc.toFixed(2)),
    dmc: Number(dmc.toFixed(2)),
    dc: Number(dc.toFixed(2)),
    isi: Number(isi.toFixed(2)),
    bui: Number(bui.toFixed(2)),
    fwi: Number(fwi.toFixed(2)),
    class: classifyFWI(fwi)
  };
}

module.exports = {
  computeFWI
};
