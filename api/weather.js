import { authenticateRequest, jsonResponse } from './push.js';

const KMA_BASE_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const LOCATION = {
  name: '지산컨트리클럽',
  latitude: 37.2137,
  longitude: 127.34099,
  nx: 62,
  ny: 117
};

function getKoreaDateParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
}

function formatDateTime(date) {
  return {
    date: `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`,
    time: `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}`
  };
}

function shiftedDateTime(date, minutes) {
  const parts = getKoreaDateParts(date);
  const shifted = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute) + minutes
  ));
  return formatDateTime(shifted);
}

function getObservationBaseTimes() {
  return [0, -60, -120].map(offset => {
    const value = shiftedDateTime(new Date(), offset);
    return { date: value.date, time: `${value.time.slice(0, 2)}00` };
  });
}

function getForecastBaseTimes() {
  const target = shiftedDateTime(new Date(), -15);
  const targetDate = new Date(Date.UTC(
    Number(target.date.slice(0, 4)),
    Number(target.date.slice(4, 6)) - 1,
    Number(target.date.slice(6, 8)),
    Number(target.time.slice(0, 2)),
    Number(target.time.slice(2, 4))
  ));
  targetDate.setUTCMinutes(targetDate.getUTCMinutes() - (targetDate.getUTCMinutes() % 30));

  return [0, -30, -60].map(offset => {
    const value = formatDateTime(new Date(targetDate.getTime() + offset * 60 * 1000));
    return { date: value.date, time: value.time };
  });
}

async function fetchKmaItems(endpoint, baseTimes, serviceKey) {
  let lastError;
  for (const base of baseTimes) {
    const url = new URL(`${KMA_BASE_URL}/${endpoint}`);
    url.search = new URLSearchParams({
      serviceKey,
      pageNo: '1',
      numOfRows: '1000',
      dataType: 'JSON',
      base_date: base.date,
      base_time: base.time,
      nx: String(LOCATION.nx),
      ny: String(LOCATION.ny)
    });

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`기상청 API HTTP ${response.status}`);
      const payload = await response.json();
      const result = payload?.response;
      if (result?.header?.resultCode !== '00') {
        throw new Error(result?.header?.resultMsg || '기상청에서 날씨 자료를 반환하지 않았습니다.');
      }
      const items = result?.body?.items?.item;
      if (!Array.isArray(items) || !items.length) {
        throw new Error('기상청 날씨 자료가 비어 있습니다.');
      }
      return { items, base };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('기상청 날씨 자료를 가져오지 못했습니다.');
}

function groupByCategory(items) {
  return new Map(items.map(item => [item.category, item.obsrValue ?? item.fcstValue]));
}

function getCondition(sky, precipitation) {
  const rainType = Number(precipitation);
  if (rainType === 1 || rainType === 4) return { text: rainType === 4 ? '소나기' : '비', icon: '🌧️' };
  if (rainType === 2 || rainType === 6) return { text: '비 또는 눈', icon: '🌨️' };
  if (rainType === 3 || rainType === 7) return { text: '눈', icon: '❄️' };
  if (rainType === 5) return { text: '빗방울', icon: '🌦️' };
  if (rainType === 0 && Number(sky) === 1) return { text: '맑음', icon: '☀️' };
  if (Number(sky) === 3) return { text: '구름 많음', icon: '🌤️' };
  if (Number(sky) === 4) return { text: '흐림', icon: '☁️' };
  return { text: '날씨 정보 확인 중', icon: '🌥️' };
}

function formatForecastTime(item) {
  const hour = Number(item.fcstTime.slice(0, 2));
  return `${String(hour).padStart(2, '0')}시`;
}

async function getWeather(serviceKey) {
  const [observations, forecasts] = await Promise.all([
    fetchKmaItems('getUltraSrtNcst', getObservationBaseTimes(), serviceKey),
    fetchKmaItems('getUltraSrtFcst', getForecastBaseTimes(), serviceKey)
  ]);

  const observedValues = groupByCategory(observations.items);
  const forecastByTime = new Map();
  for (const item of forecasts.items) {
    const key = `${item.fcstDate}${item.fcstTime}`;
    if (!forecastByTime.has(key)) forecastByTime.set(key, new Map());
    forecastByTime.get(key).set(item.category, item.fcstValue);
  }

  const now = getKoreaDateParts();
  const nowKey = `${now.year}${now.month}${now.day}${now.hour}${now.minute}`;
  const hourly = [...forecastByTime.entries()]
    .filter(([key]) => key >= nowKey)
    .sort(([first], [second]) => first.localeCompare(second))
    .slice(0, 8)
    .map(([key, values]) => {
      const condition = getCondition(values.get('SKY'), values.get('PTY'));
      return {
        date: key.slice(0, 8),
        time: `${key.slice(8, 10)}${key.slice(10, 12)}`,
        label: `${key.slice(8, 10)}시`,
        temperature: values.get('T1H') ?? null,
        condition: condition.text,
        icon: condition.icon,
        precipitation: values.get('RN1') ?? '강수 없음',
        wind: values.get('WSD') ?? null
      };
    });

  const nearestForecast = [...forecastByTime.entries()]
    .filter(([key]) => key >= nowKey)
    .sort(([first], [second]) => first.localeCompare(second))[0]?.[1];
  const condition = getCondition(nearestForecast?.get('SKY'), observedValues.get('PTY'));
  return {
    location: LOCATION.name,
    provider: '기상청 동네예보',
    observedAt: `${observations.base.date}T${observations.base.time}`,
    updatedAt: new Date().toISOString(),
    current: {
      temperature: observedValues.get('T1H') ?? null,
      humidity: observedValues.get('REH') ?? null,
      wind: observedValues.get('WSD') ?? null,
      precipitation: observedValues.get('RN1') ?? '강수 없음',
      condition: condition.text,
      icon: condition.icon
    },
    hourly
  };
}

export async function handleGetWeather(request, supabaseAdmin, env, ctx) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;
  if (!env.KMA_SERVICE_KEY) {
    return jsonResponse({ error: '기상청 API 키가 Worker의 KMA_SERVICE_KEY 비밀 변수에 설정되지 않았습니다.' }, 503);
  }

  const cache = globalThis.caches?.default;
  const cacheKey = new Request('https://jsec-weather-cache.internal/api/weather');
  if (cache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) return cachedResponse;
  }

  try {
    const weather = await getWeather(env.KMA_SERVICE_KEY);
    const response = new Response(JSON.stringify(weather), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600, s-maxage=600'
      }
    });
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error('기상청 날씨 조회 오류:', error);
    return jsonResponse({ error: error.message || '기상청 날씨 정보를 불러오지 못했습니다.' }, 502);
  }
}
