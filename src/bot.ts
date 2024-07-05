import { config } from "./config.js";
import {ContactImpl, ContactInterface, RoomImpl, RoomInterface} from "wechaty/impls";
import { Message, Wechaty } from "wechaty";
import {FileBox} from "file-box";
import {chatgpt, dalle, whisper} from "./openai.js";
import DBUtils from "./data.js";
import { regexpEncode } from "./utils.js";
import {sendMsg} from "./api.js";

enum MessageType {
  Unknown = 0,
  Attachment = 1, // Attach(6),
  Audio = 2, // Audio(1), Voice(34)
  Contact = 3, // ShareCard(42)
  ChatHistory = 4, // ChatHistory(19)
  Emoticon = 5, // Sticker: Emoticon(15), Emoticon(47)
  Image = 6, // Img(2), Image(3)
  Text = 7, // Text(1)
  Location = 8, // Location(48)
  MiniProgram = 9, // MiniProgram(33)
  GroupNote = 10, // GroupNote(53)
  Transfer = 11, // Transfers(2000)
  RedEnvelope = 12, // RedEnvelopes(2001)
  Recalled = 13, // Recalled(10002)
  Url = 14, // Url(5)
  Video = 15, // Video(4), Video(43)
  Post = 16, // Moment, Channel, Tweet, etc
}
const SINGLE_MESSAGE_MAX_SIZE = 500;
type Speaker = RoomImpl | ContactImpl;
interface ICommand{
  name:string;
  description:string;
  exec: (talker:Speaker, text:string) => Promise<void>;
}
export class ChatGPTBot {
  chatPrivateTriggerKeyword = config.chatPrivateTriggerKeyword;
  chatTriggerRule = config.chatTriggerRule? new RegExp(config.chatTriggerRule): undefined;
  disableGroupMessage = config.disableGroupMessage || false;
  botName: string = "";
  ready = false;
  setBotName(botName: string) {
    this.botName = botName;
  }
  get chatGroupTriggerRegEx(): RegExp {
    return new RegExp(`^@${regexpEncode(this.botName)}\\s`);
  }
  get chatPrivateTriggerRule(): RegExp | undefined {
    const { chatPrivateTriggerKeyword, chatTriggerRule } = this;
    let regEx = chatTriggerRule
    if (!regEx && chatPrivateTriggerKeyword) {
      regEx = new RegExp(regexpEncode(chatPrivateTriggerKeyword))
    }
    return regEx
  }
  private readonly commands:ICommand[] = [
    {
      name: "help",
      description: "显示帮助信息",
      exec: async (talker) => {
        await this.trySay(talker,"========\n" +
          "/cmd help\n" +
          "# 显示帮助信息\n" +
          "/cmd prompt <PROMPT>\n" +
          "# 设置当前会话的 prompt \n" +
          "/img <PROMPT>\n" +
          "# 根据 prompt 生成图片\n" +
          "/cmd clear\n" +
          "# 清除自上次启动以来的所有会话\n" +
          "========");
      }
    },
    {
      name: "prompt",
      description: "设置当前会话的prompt",
      exec: async (talker, prompt) => {
        if (talker instanceof RoomImpl) {
          DBUtils.setPrompt(await talker.topic(), prompt);
        }else {
          DBUtils.setPrompt(talker.name(), prompt);
        }
      }
    },
    {
      name: "clear",
      description: "清除自上次启动以来的所有会话",
      exec: async (talker) => {
        if (talker instanceof RoomImpl) {
          DBUtils.clearHistory(await talker.topic());
        }else{
          DBUtils.clearHistory(talker.name());
        }
      }
    },
    {
      name: "msg",
      description:"",
      exec: async (talker, msg) => {
        const we = talker.wechaty
        msg = msg + "(非本微信号)"
        const rooms = we.Room.findAll()
        rooms.then((value) => {
            for(const room of value) {
                console.log(room)
                console.log(msg)
                room.say(msg)
            }
        })
        talker.say(msg + "【已发送】")

      }
    }
  ]

  /**
   * EXAMPLE:
   *       /cmd help
   *       /cmd prompt <PROMPT>
   *       /cmd img <PROMPT>
   *       /cmd clear
   * @param contact
   * @param rawText
   */
  async command(contact: any, rawText: string): Promise<void> {
    const [commandName, ...args] = rawText.split(/\s+/);
    const command = this.commands.find(
      (command) => command.name === commandName
    );
    if (command) {
      await command.exec(contact, args.join(" "));
    }
  }
  // remove more times conversation and mention
  cleanMessage(rawText: string, privateChat: boolean = false): string {
    let text = rawText;
    const item = rawText.split("- - - - - - - - - - - - - - -");
    if (item.length > 1) {
      text = item[item.length - 1];
    }

    const { chatTriggerRule, chatPrivateTriggerRule } = this;

    if (privateChat && chatPrivateTriggerRule) {
      text = text.replace(chatPrivateTriggerRule, "")
    } else if (!privateChat) {
      text = text.replace(this.chatGroupTriggerRegEx, "")
      text = chatTriggerRule? text.replace(chatTriggerRule, ""): text
    }
    // remove more text via - - - - - - - - - - - - - - -
    return text
  }
  async getGPTMessage(talkerName: string,text: string): Promise<string> {
    let gptMessage = await chatgpt(talkerName,text);
    if (gptMessage !=="") {
      DBUtils.addAssistantMessage(talkerName,gptMessage);
      return gptMessage;
    }
    return "Sorry, please try again later. 😔";
  }
  // Check if the message returned by chatgpt contains masked words]
  checkChatGPTBlockWords(message: string): boolean {
    if (config.chatgptBlockWords.length == 0) {
      return false;
    }
    return config.chatgptBlockWords.some((word) => message.includes(word));
  }
  // The message is segmented according to its size
  async trySay(
    talker: RoomInterface | ContactInterface,
    mesasge: string
  ): Promise<void> {
    const messages: Array<string> = [];
    if (this.checkChatGPTBlockWords(mesasge)) {
      console.log(`🚫 Blocked ChatGPT: ${mesasge}`);
      return;
    }
    let message = mesasge;
    while (message.length > SINGLE_MESSAGE_MAX_SIZE) {
      messages.push(message.slice(0, SINGLE_MESSAGE_MAX_SIZE));
      message = message.slice(SINGLE_MESSAGE_MAX_SIZE);
    }
    messages.push(message);
    for (const msg of messages) {
      await talker.say(msg);
    }
  }
  
  // Check whether the message contains the blocked words. if so, the message will be ignored. if so, return true
  checkBlockWords(message: string): boolean {
    if (config.blockWords.length == 0) {
      return false;
    }
    return config.blockWords.some((word) => message.includes(word));
  }
  // Filter out the message that does not need to be processed
  isNonsense(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean {
    return (
      talker.self() ||
      // TODO: add doc support
      !(messageType == MessageType.Text || messageType == MessageType.Audio) ||
      talker.name() === "微信团队" ||
      // 语音(视频)消息
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      // 红包消息
      text.includes("收到红包，请在手机上查看") ||
      // Transfer message
      text.includes("收到转账，请在手机上查看") ||
      // 位置消息
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg") ||
      // 聊天屏蔽词
      this.checkBlockWords(text)
    );
  }

  async onPrivateMessage(talker: ContactInterface, text: string) {
    const gptMessage = await this.getGPTMessage(talker.name(),text);
    await this.trySay(talker, gptMessage);
  }

  async onGroupMessage(
    talker: ContactInterface,
    text: string,
    room: RoomInterface
  ) {
    const gptMessage = await this.getGPTMessage(await room.topic(),text);
    const result = `@${talker.name()} ${text}\n\n------\n ${gptMessage}`;
    await this.trySay(room, result);
  }
  async onMessage(self:Wechaty, message: Message) {
    const talker = message.talker();
    const rawText = message.text();
    const room = message.room();
    const messageType = message.type();
    const privateChat = !room;
    if (this.isNonsense(talker, messageType, rawText)) {
      return;
    }
    if (privateChat) {
      console.log(`🤵 Contact: ${talker.name()} 💬 Text: ${rawText}`)
      this.onPrivateMessage(talker,rawText)
      return;
    } else {
      const topic = await room.topic()
      console.log(`🚪 Room: ${topic} 🤵 Contact: ${talker.name()} 💬 Text: ${rawText}`)
    }
    console.log(`📱 Phone :  🤵 Contact: ${talker.name()} 💬 number: ${talker.phone()}`)
    if (messageType == MessageType.Audio){
      // 保存语音文件
      const fileBox = await message.toFileBox();
      let fileName = "./public/" + fileBox.name;
      await fileBox.toFile(fileName, true).catch((e) => {
        console.log("保存语音失败",e);
        return;
      });
      // Whisper
      whisper("",fileName).then((text) => {
        message.say(text);
      })
      return;
    }
    if (rawText.startsWith("/cmd ")){
      console.log(`🤖 Command: ${rawText}`)
      const cmdContent = rawText.slice(5) // 「/cmd 」一共5个字符(注意空格)
      if (privateChat) {
        await this.command(talker, cmdContent);
      }else{
        await this.command(room, cmdContent);
      }
      return;
    }

    if (rawText.includes("人找车") || rawText.includes("车找人")){
      console.log(`🚗 Car search: ${rawText}`);
      const carContent = rawText.slice(3); // 「/找车」一共3个字符
      let carSearchResult = await carSearch(carContent) as string;
      sendMsg(rawText);
      return;
      
    }

    // 找人
 
    if (rawText.includes("车找人")) {
      console.log(`🔍 Searching for people: ${rawText}`);
      const contactAlias = await self.Contact.find({ alias: "xueshaoyi"})
      contactAlias?.say(rawText)
      // const peopleContent = rawText.slice(3); // 「/找人」一共3个字符
      // let peopleSearchResult = await peopleSearch(peopleContent) as string;
      // if (privateChat) {
        // await this.trySay(talker, peopleSearchResult);
      // } else {
        // await this.trySay(room, peopleSearchResult);
      // }
      return;
    }


    
    // if (this.triggerGPTMessage(rawText, privateChat)) {
    //   const text = this.cleanMessage(rawText, privateChat);
    //   if (privateChat) {
    //     return await this.onPrivateMessage(talker, text);
    //   } else{
    //     if (!this.disableGroupMessage){
    //       return await this.onGroupMessage(talker, text, room);
    //     } else {
    //       return;
    //     }
    //   }
    // } else {
    //   return;
    // }

    console.log(`🚗 Car search: ${rawText}`);
    const carContent = rawText.slice(3); // 「/找车」一共3个字符
    let carSearchResult = await carSearch(carContent) as string;

    return;
  }
  
}
// 将String 分析  分析出时间 出发点 终点 和电话
/**
【时间】：4号周日下午5点
【始发】：辛集飞马酒店
【终点】：北京天宫院地铁站
【电话】：15931539938（同微信）
 * @param carContent 
 * @returns 
 */
async function carSearch(carContent: string): Promise<string> {
  // Regular expressions to match time, departure, destination, and phone number
  const timeRegex = /【时间】(.*?)\n/;
  const departureRegex = /【出发】(.*?)\n/;
  const destinationRegex = /【终点】(.*?)\n/;
  const phoneRegex = /【电话】(.*?)\n/;

  // Extract the information using the regular expressions
  const timeMatch = carContent.match(timeRegex);
  const departureMatch = carContent.match(departureRegex);
  const destinationMatch = carContent.match(destinationRegex);
  const phoneMatch = carContent.match(phoneRegex);

  // Check if all the information is present
  if (timeMatch && departureMatch && destinationMatch && phoneMatch) {
    const time = timeMatch[1];
    const departure = departureMatch[1];
    const destination = destinationMatch[1];
    const phone = phoneMatch[1];

    // Format the extracted information
    const result = `Time: ${time}\nDeparture: ${departure}\nDestination: ${destination}\nPhone: ${phone}`;
    console.log("result log ", result)
    return result;
  } else {
    return "Invalid car search format. Please check your input.";
  }
}

 
  /**
   * Search for people based on the given input.
   * @param peopleContent The input to search for people.
   * @returns A string containing the search results.
   */
  async function peopleSearch(peopleContent: string): Promise<string> {
    // Regular expressions to match name, age, gender, and phone number
    const timeRegex = /【时间】(.*?)\n/;
    const departureRegex = /【出发】(.*?)\n/;
    const destinationRegex = /【终点】(.*?)\n/;
    const phoneRegex = /【电话】(.*?)\n/;

    // Extract the information using the regular expressions
    const timeMatch = peopleContent.match(timeRegex);
    const departureMatch = peopleContent.match(departureRegex);
    const destinationMatch = peopleContent.match(destinationRegex);
    const phoneMatch = peopleContent.match(phoneRegex);

    // Check if all the information is present
    if (timeMatch && departureMatch && destinationMatch && phoneMatch) {
      const time = timeMatch[1];
      const departure = departureMatch[1];
      const destination = destinationMatch[1];
      const phone = phoneMatch[1];
  
      // Format the extracted information
      const result = `Time: ${time}\nDeparture: ${departure}\nDestination: ${destination}\nPhone: ${phone}`;
      console.log("result log ", result)
      return result;
    } else {
      return "Invalid car search format. Please check your input.";
    }
  }
  async function getRooms(bot:Wechaty) {
    return bot.Room.findAll();
  }


