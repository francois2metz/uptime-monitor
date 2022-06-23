import { SiteCurrentStatus, UpptimeConfigSite } from "../interfaces";
import { ping } from "../helpers/ping";
import { replaceEnvironmentVariables } from "../helpers/environment";

export default async function(site: UpptimeConfigSite): Promise<{
  result: {
    httpCode: number;
  };
  responseTime: string;
  status: SiteCurrentStatus;
}> {
  console.log("Using tcp-ping instead of curl");
  try {
    let status: SiteCurrentStatus = "up";
    const tcpResult = await ping({
      address: replaceEnvironmentVariables(site.url),
      attempts: 5,
      port: Number(replaceEnvironmentVariables(site.port ? String(site.port) : "")),
    });
    if(tcpResult.results.every(result => Object.prototype.toString.call((result as any).err) === "[object Error]"))
      throw Error('all attempts failed');
    console.log("Got result", tcpResult);
    let responseTime = (tcpResult.avg || 0).toFixed(0);
    if (parseInt(responseTime) > (site.maxResponseTime || 60000)) status = "degraded";
    return {
      result: { httpCode: 200 },
      responseTime,
      status,
    };
  } catch (error) {
    console.log("ERROR Got pinging error", error);
    return { result: { httpCode: 0 }, responseTime: (0).toFixed(0), status: "down" };
  }
}
