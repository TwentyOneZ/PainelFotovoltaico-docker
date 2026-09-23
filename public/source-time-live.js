(() => {
  // Live View source-time alignment
  // --------------------------------
  // The backend heartbeat is still the canonical 1 Hz persistence snapshot, but
  // plotting every signal at heartbeat_ts hides the real phase difference between
  // independent MQTT publishers. For Live View, use the receipt timestamp that
  // actually belongs to each source.
  //
  // Generator electrical quantities -> generator_last_received_ts
  // Reference/model quantities      -> reference_last_received_ts
  // Other quantities                -> heartbeat_ts (until they receive their own
  //                                    explicit source timestamps).

  const GENERATOR_METRICS = new Set(['voltage', 'current_mA', 'power_mW']);
  const REFERENCE_METRICS = new Set([
    'irradiance',
    'estimatedPower',
    'expectedLoadVoltage',
    'expectedLoadCurrent',
    'estimatedVmp',
    'estimatedImp',
    'estimatedMppPower'
  ]);

  function sourceTimestampForMetric(snapshot, metric) {
    if (!snapshot) return null;
    if (GENERATOR_METRICS.has(metric)) {
      return snapshot.generator_last_received_ts || snapshot.heartbeat_ts || snapshot.ts;
    }
    if (REFERENCE_METRICS.has(metric)) {
      return snapshot.reference_last_received_ts || snapshot.heartbeat_ts || snapshot.ts;
    }
    return snapshot.heartbeat_ts || snapshot.ts;
  }

  async function fetchSourceTimedReadings(metric, startISO, endISO, maxPoints) {
    const url = new URL('/api/live-source-readings', location.origin);
    url.searchParams.set('metric', metric);
    url.searchParams.set('start', startISO);
    url.searchParams.set('end', endISO);
    if (maxPoints) url.searchParams.set('maxPoints', String(maxPoints));
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Erro na API source-time: ${res.status}`);
    return res.json();
  }

  // Override only the helper used by the Live View cache. The normal historical
  // "Exibir gráfico" path continues using /api/readings and heartbeat timestamps,
  // preserving its current behaviour and backwards compatibility.
  fetchMetricInto = async function sourceTimedFetchMetricInto(c, metric, map, start, end, max) {
    if (end <= start) return;
    const raw = await fetchSourceTimedReadings(
      metric,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
      max
    );
    for (const p of raw) pointInto(map, p.ts, p[metric] ?? p.value);
  };

  // Each heartbeat may repeat a value whose source did not publish again. Because
  // the Map is keyed by the source timestamp, repeated heartbeats collapse into a
  // single measurement point instead of creating artificial 1 Hz samples.
  snapshotsIntoCache = function sourceTimedSnapshotsIntoCache(c, rows) {
    for (const s of rows) {
      const primaryTs = sourceTimestampForMetric(s, c.metric);
      pointInto(c.primary, primaryTs, s[c.metric]);

      if (c.metric === 'power_mW') {
        const estimatedTs = sourceTimestampForMetric(s, 'estimatedPower');
        pointInto(c.secondary, estimatedTs, s.estimatedPower);
      }
    }
    trimCache(c);
  };

  console.info('[live-source-time] Live View usando timestamps reais de recebimento por origem.');
})();
