function parseROI(roiRaw){
  const defaults = { blocks_added:1, saved_minutes:15, rate_usd_per_hour:120 };
  if (!roiRaw) return { ...defaults, value_usd_est: (defaults.saved_minutes/60)*defaults.rate_usd_per_hour, assumptions: "" };
  const m = {
    blocks_added: Number((roiRaw.match(/blocks?_added\D+(\d+)/i) || [])[1]),
    saved_minutes: Number((roiRaw.match(/saved_minutes?\D+(\d+)/i) || [])[1]),
    rate_usd_per_hour: Number((roiRaw.match(/rate.*?(\d+(\.\d+)?)/i) || [])[1])
  };
  const v = {
    blocks_added: m.blocks_added || 1,
    saved_minutes: m.saved_minutes || 15,
    rate_usd_per_hour: m.rate_usd_per_hour || 120
  };
  const value = Math.round(((v.saved_minutes/60)*v.rate_usd_per_hour)*100)/100;
  return { ...v, value_usd_est: value, assumptions: roiRaw.trim() };
}

function aggregateROI(items){
  const agg = { blocks_added:0, saved_minutes:0, rate_usd_per_hour:120, value_usd_est:0 };
  for (const r of items) {
    agg.blocks_added += r.blocks_added;
    agg.saved_minutes += r.saved_minutes;
    agg.value_usd_est += r.value_usd_est;
  }
  agg.value_usd_est = Math.round(agg.value_usd_est*100)/100;
  return agg;
}
module.exports = { parseROI, aggregateROI };
