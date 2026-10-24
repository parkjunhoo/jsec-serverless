import { authenticateRequest, jsonResponse } from './push.js';

const KMA_BASE_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const DEFAULT_LOCATION = {
  name: '지산컨트리클럽',
  latitude: 37.2137,
  longitude: 127.34099
};
const KMA_GRID = {
  earthRadiusKm: 6371.00877,
  spacingKm: 5,
  standardLatitude1: 30,
  standardLatitude2: 60,
  originLongitude: 126,
  originLatitude: 38,
  originX: 43,
  originY: 136
};

class KmaApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'KmaApiError';
    this.status = status;
  }
}

function normalizeServiceKey(value) {
  const serviceKey = String(value || '').trim();
  if (/%[0-9a-f]{2}/i.test(serviceKey)) {
    try {
      return decodeURIComponent(serviceKey);
    } catch {
      throw new Error('Worker의 KMA_SERVICE_KEY가 올바르지 않은 URL 인코딩 형식입니다.');
    }
  }
  return serviceKey;
}

function decodeXmlText(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function getKmaResponseMessage(body) {
  const jsonMessage = body.match(/"(?:resultMsg|errMsg|returnAuthMsg)"\s*:\s*"([^"]+)"/i)?.[1];
  const xmlMessage = body.match(/<(?:resultMsg|errMsg|returnAuthMsg)>([\s\S]*?)<\/(?:resultMsg|errMsg|returnAuthMsg)>/i)?.[1];
  const message = decodeXmlText((jsonMessage || xmlMessage || '').trim())
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 240);
  const code = body.match(/<(?:resultCode|returnReasonCode)>([\s\S]*?)<\/(?:resultCode|returnReasonCode)>/i)?.[1]
    || body.match(/"(?:resultCode|returnReasonCode)"\s*:\s*"([^"]+)"/i)?.[1]
    || '';

  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|SERVICE_KEY|인증키|서비스키/i.test(`${code} ${message}`)) {
    return '기상청 서비스키가 유효하지 않거나 해당 API 사용 승인이 완료되지 않았습니다. data.go.kr의 활용 신청·승인 상태와 Worker KMA_SERVICE_KEY를 확인해 주세요.';
  }
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS|TRAFFIC|트래픽|호출 한도/i.test(`${code} ${message}`)) {
    return '기상청 API 호출 한도를 초과했습니다. data.go.kr의 일일 트래픽 한도와 활용 신청 상태를 확인해 주세요.';
  }
  return message || '기상청 API가 요청을 거부했습니다. 서비스키 승인·유효기간·호출 한도와 요청 정보를 확인해 주세요.';
}

async function createKmaHttpError(response, endpoint) {
  const body = (await response.text()).slice(0, 2000);
  const message = response.status === 401 || response.status === 403
    ? getKmaResponseMessage(body)
    : body.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240) || response.statusText;
  return new KmaApiError(`기상청 ${endpoint} HTTP ${response.status}: ${message}`, response.status);
}

function toKmaGrid(latitude, longitude) {
  const radians = degrees => degrees * Math.PI / 180;
  const earthRadius = KMA_GRID.earthRadiusKm / KMA_GRID.spacingKm;
  const standardLatitude1 = radians(KMA_GRID.standardLatitude1);
  const standardLatitude2 = radians(KMA_GRID.standardLatitude2);
  const originLatitude = radians(KMA_GRID.originLatitude);
  const sn = Math.log(Math.cos(standardLatitude1) / Math.cos(standardLatitude2))
    / Math.log(Math.tan(Math.PI / 4 + standardLatitude2 / 2) / Math.tan(Math.PI / 4 + standardLatitude1 / 2));
  const sf = Math.tan(Math.PI / 4 + standardLatitude1 / 2) ** sn
    * Math.cos(standardLatitude1) / sn;
  const ro = earthRadius * sf / Math.tan(Math.PI / 4 + originLatitude / 2) ** sn;
  const ra = earthRadius * sf / Math.tan(Math.PI / 4 + radians(latitude) / 2) ** sn;
  let theta = longitude - KMA_GRID.originLongitude;
  if (theta > 180) theta -= 360;
  if (theta < -180) theta += 360;
  theta = radians(theta) * sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + KMA_GRID.originX + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + KMA_GRID.originY + 0.5)
  };
}

function getRequestedLocation(url) {
  const latitudeValue = url.searchParams.get('lat');
  const longitudeValue = url.searchParams.get('lon');
  if (latitudeValue === null && longitudeValue === null) {
    return { ...DEFAULT_LOCATION, ...toKmaGrid(DEFAULT_LOCATION.latitude, DEFAULT_LOCATION.longitude) };
  }
  if (latitudeValue === null || longitudeValue === null) {
    throw new Error('위도와 경도를 모두 입력해 주세요.');
  }
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  if (!Number.isFinite(latitude) || latitude < 32 || latitude > 40
    || !Number.isFinite(longitude) || longitude < 123 || longitude > 133) {
    throw new Error('날씨 위치는 대한민국 내의 유효한 좌표로 지정해 주세요.');
  }
  const displayName = (url.searchParams.get('name') || '선택한 위치')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 100);
  return {
    name: displayName || '선택한 위치',
    latitude,
    longitude,
    ...toKmaGrid(latitude, longitude)
  };
}

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

function getVillageForecastBaseTimes() {
  const target = shiftedDateTime(new Date(), -15);
  const targetDate = new Date(Date.UTC(
    Number(target.date.slice(0, 4)),
    Number(target.date.slice(4, 6)) - 1,
    Number(target.date.slice(6, 8)),
    Number(target.time.slice(0, 2))
  ));
  const hour = targetDate.getUTCHours();
  targetDate.setUTCHours(hour >= 2 ? 2 + Math.floor((hour - 2) / 3) * 3 : 23);
  if (hour < 2) targetDate.setUTCDate(targetDate.getUTCDate() - 1);

  return [0, -3, -6].map(offset => {
    const value = formatDateTime(new Date(targetDate.getTime() + offset * 60 * 60 * 1000));
    return { date: value.date, time: `${value.time.slice(0, 2)}00` };
  });
}

async function fetchKmaItems(endpoint, baseTimes, serviceKey, location) {
  let lastError;
  for (const base of baseTimes) {
    const url = new URL(`${KMA_BASE_URL}/${endpoint}`);
    url.search = new URLSearchParams({
      serviceKey: normalizeServiceKey(serviceKey),
      pageNo: '1',
      numOfRows: '1000',
      dataType: 'JSON',
      base_date: base.date,
      base_time: base.time,
      nx: String(location.nx),
      ny: String(location.ny)
    });

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw await createKmaHttpError(response, endpoint);
      const responseBody = await response.text();
      let payload;
      try {
        payload = JSON.parse(responseBody);
      } catch {
        throw new Error(`기상청 ${endpoint} 응답이 JSON 형식이 아닙니다.`);
      }
      const result = payload?.response;
      if (result?.header?.resultCode !== '00') {
        const message = result?.header?.resultMsg || '기상청에서 날씨 자료를 반환하지 않았습니다.';
        if (/SERVICE_KEY|SERVICE_ACCESS|인증키|서비스키|LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(`${result?.header?.resultCode} ${message}`)) {
          throw new KmaApiError(`기상청 ${endpoint}: ${message}`, 403);
        }
        throw new Error(`기상청 ${endpoint}: ${message}`);
      }
      const items = result?.body?.items?.item;
      if (!Array.isArray(items) || !items.length) {
        throw new Error('기상청 날씨 자료가 비어 있습니다.');
      }
      return { items, base };
    } catch (error) {
      if (error instanceof KmaApiError) throw error;
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

async function getWeather(serviceKey, location) {
  const [observations, shortForecasts, villageForecasts] = await Promise.all([
    fetchKmaItems('getUltraSrtNcst', getObservationBaseTimes(), serviceKey, location),
    fetchKmaItems('getUltraSrtFcst', getForecastBaseTimes(), serviceKey, location),
    fetchKmaItems('getVilageFcst', getVillageForecastBaseTimes(), serviceKey, location)
  ]);

  const observedValues = groupByCategory(observations.items);
  const forecastByTime = new Map();
  for (const item of villageForecasts.items) {
    const key = `${item.fcstDate}${item.fcstTime}`;
    if (!forecastByTime.has(key)) forecastByTime.set(key, new Map());
    forecastByTime.get(key).set(item.category, item.fcstValue);
  }
  for (const item of shortForecasts.items) {
    const key = `${item.fcstDate}${item.fcstTime}`;
    if (!forecastByTime.has(key)) forecastByTime.set(key, new Map());
    forecastByTime.get(key).set(item.category, item.fcstValue);
  }

  const now = getKoreaDateParts();
  const nowKey = `${now.year}${now.month}${now.day}${now.hour}${now.minute}`;
  const hourly = [...forecastByTime.entries()]
    .filter(([key]) => key >= nowKey)
    .sort(([first], [second]) => first.localeCompare(second))
    .slice(0, 48)
    .map(([key, values]) => {
      const condition = getCondition(values.get('SKY'), values.get('PTY'));
      return {
        date: key.slice(0, 8),
        time: `${key.slice(8, 10)}${key.slice(10, 12)}`,
        label: key.slice(0, 8) === `${now.year}${now.month}${now.day}`
          ? `${key.slice(8, 10)}시`
          : `${key.slice(4, 6)}.${key.slice(6, 8)} ${key.slice(8, 10)}시`,
        temperature: values.get('TMP') ?? values.get('T1H') ?? null,
        condition: condition.text,
        icon: condition.icon,
        precipitation: values.get('PCP') ?? values.get('RN1') ?? '강수 없음',
        precipitationProbability: values.get('POP') ?? null,
        wind: values.get('WSD') ?? null
      };
    });

  const nearestForecast = [...forecastByTime.entries()]
    .filter(([key]) => key >= nowKey)
    .sort(([first], [second]) => first.localeCompare(second))[0]?.[1];
  const condition = getCondition(nearestForecast?.get('SKY'), observedValues.get('PTY'));
  return {
    location: location.name,
    provider: '기상청 동네예보',
    observedAt: `${observations.base.date}T${observations.base.time}`,
    updatedAt: new Date().toISOString(),
    current: {
      temperature: observedValues.get('T1H') ?? null,
      humidity: observedValues.get('REH') ?? null,
      wind: observedValues.get('WSD') ?? null,
      precipitation: observedValues.get('RN1') ?? '강수 없음',
      precipitationProbability: nearestForecast?.get('POP') ?? null,
      condition: condition.text,
      icon: condition.icon
    },
    hourly
  };
}

export async function handleGetWeather(request, supabaseAdmin, env, ctx) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;
  let location;
  try {
    location = getRequestedLocation(new URL(request.url));
  } catch (error) {
    return jsonResponse({ error: error.message }, 400);
  }
  if (!env.KMA_SERVICE_KEY) {
    return jsonResponse({ error: '기상청 API 키가 Worker의 KMA_SERVICE_KEY 비밀 변수에 설정되지 않았습니다.' }, 503);
  }

  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`https://jsec-weather-cache.internal/api/weather?nx=${location.nx}&ny=${location.ny}`);
  if (cache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const weather = await cachedResponse.json();
      weather.location = location.name;
      return new Response(JSON.stringify(weather), {
        headers: cachedResponse.headers
      });
    }
  }

  try {
    const weather = await getWeather(env.KMA_SERVICE_KEY, location);
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
