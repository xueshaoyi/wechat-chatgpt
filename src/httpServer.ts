import * as http from "http";
import { Message, Wechaty } from "wechaty";



export class HttpServer{

    async startServer(self:Wechaty) {
        const bot = self;
        const server = http.createServer();
        console.log('http server start');

        server.on('request', (request, response) => {
            console.log(request.url)
            console.log(request.method)
            response.end('hi')
        })

        server.listen(8888)
    }
}
