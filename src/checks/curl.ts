import { SiteCurrentStatus, UpptimeConfigSite } from "../interfaces";
import { curl } from "../helpers/request";

export default async function(site: UpptimeConfigSite): Promise<{
  result: {
    httpCode: number;
  };
  responseTime: string;
  status: SiteCurrentStatus;
}> {
  const result = await curl(site);
  console.log("Result from test", result.httpCode, result.totalTime);
  const responseTime = (result.totalTime * 1000).toFixed(0);
  const expectedStatusCodes = (
    site.expectedStatusCodes || [
      200,
      201,
      202,
      203,
      200,
      204,
      205,
      206,
      207,
      208,
      226,
      300,
      301,
      302,
      303,
      304,
      305,
      306,
      307,
      308,
    ]
  ).map(Number);
  let status: SiteCurrentStatus = expectedStatusCodes.includes(
    Number(result.httpCode)
  )
    ? "up"
    : "down";
  if (parseInt(responseTime) > (site.maxResponseTime || 60000)) status = "degraded";
  if (status === "up" && typeof result.data === "string") {
    if (site.__dangerous__body_down && result.data.includes(site.__dangerous__body_down))
      status = "down";
    if (
      site.__dangerous__body_degraded &&
        result.data.includes(site.__dangerous__body_degraded)
    )
      status = "degraded";
  }
  if (
    site.__dangerous__body_degraded_if_text_missing &&
      !result.data.includes(site.__dangerous__body_degraded_if_text_missing)
  )
    status = "degraded";
  if (
    site.__dangerous__body_down_if_text_missing &&
      !result.data.includes(site.__dangerous__body_down_if_text_missing)
  )
    status = "down";
  return { result, responseTime, status };
}
