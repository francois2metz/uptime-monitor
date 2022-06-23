import WebSocket from 'ws';
import { SiteCurrentStatus, UpptimeConfigSite } from "../interfaces";
import { replaceEnvironmentVariables } from "../helpers/environment";

export default async function(site: UpptimeConfigSite): Promise<{
  result: {
    httpCode: number;
  };
  responseTime: string;
  status: SiteCurrentStatus;
}> {
  console.log("Using websocket check instead of curl")
  let success = false;
  let status: SiteCurrentStatus = "up";
  let responseTime = "0";
  //   promise to await:
  const connect = () => {
    return new Promise(function(resolve, reject) {
      const ws = new WebSocket(replaceEnvironmentVariables(site.url));
      ws.on('open', function open() {
        if (site.body) {
          ws.send(site.body);
        } else {
          ws.send("");
        }
        ws.on('message', function message(data){
          if(data){
            success=true
          }
        })
        ws.close();
        ws.on('close', function close() {
          console.log('Websocket disconnected');
        });
        resolve(ws)
      });
      ws.on('error', function error(error: any) {
        reject(error)
      });
    })
  }
  try {
    const connection = await connect()
    if(connection) success = true
    if (success) {
      status = "up";
    } else {
      status = "down";
    };
    return {
      result: { httpCode: 200 },
      responseTime,
      status,
    };
  }
  catch (error) {
    console.log("ERROR Got pinging error from async call", error);
    return { result: { httpCode: 0 }, responseTime: (0).toFixed(0), status: "down" };
  }
}
