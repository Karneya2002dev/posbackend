const axios = require("axios");

const API_KEY = "82675ae87c5600ce9e63c5b384a469d1";

const weatherApi = axios.create({
  baseURL: "https://api.openweathermap.org/data/2.5",
});

module.exports = {
  weatherApi,
  API_KEY,
};

const getWeather = async () => {
  try {
    const response = await weatherApi.get("/weather", {
      params: {
        q: "Chennai",
        appid: API_KEY,
        units: "metric",
      },
    });

    console.log(response.data);
  } catch (error) {
    console.log(error);
  }
};

getWeather();