export interface Coordinates {
  lng: number;
  lat: number;
}

export interface GeocodeResult extends Coordinates {
  formatted_address: string;
  location_str: string;
}

export interface HourlyWeather {
  time: string;
  temperature: number | null;
  text: string;
  precipitationProbability: number | null;
  precipitation: number | null;
}

export interface QWeatherData {
  realtime: {
    temperature: number | null;
    feelsLike: number | null;
    text: string;
    humidity: number | null;
    windDir: string;
    windScale: string;
    precipitation: number | null;
  };
  hourly: HourlyWeather[];
  warning: string[];
}

export interface CaiyunData {
  keypoint: string;
  shortPrecipitation: string;
  realtime: {
    temperature: number | null;
    apparentTemp: number | null;
    skycon: string;
    humidity: number | null;
    precipitation: number | null;
    comfort: string;
    uv: string;
    aqi: number | null;
  };
  hourly: HourlyWeather[];
}

export interface WeatherQuery extends Coordinates {
  formatted_address?: string;
}

export interface WeatherPayload {
  location: string;
  queryTime: string;
  caiyun?: {
    keypoint: string;
    shortPrecipitation?: string;
    realtime: {
      temperature: string;
      apparentTemp: string;
      skycon: string;
      humidity: string;
      precipitation: number | null;
      comfort: string;
      uv: string;
      aqi: number | null;
    };
  };
  qweather?: {
    realtime: {
      temperature: string;
      feelsLike: string;
      text: string;
      humidity: string;
      precipitation: number | null;
      wind: string;
    };
    warning: string[];
  };
  comparison_summary: {
    temp_diff: string;
    rain_forecast: string;
  };
  errors?: Record<string, string>;
}
