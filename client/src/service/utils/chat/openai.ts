import { Configuration, OpenAIApi } from 'openai';
import { axiosConfig } from '../tools';
import { ChatModelMap, OpenAiChatEnum } from '@/constants/model';
import { adaptChatItem_openAI } from '@/utils/plugin/openai';
import { modelToolMap } from '@/utils/plugin';
import { ChatCompletionType, ChatContextFilter, StreamResponseType } from './index';
import { ChatRoleEnum } from '@/constants/chat';
import { parseStreamChunk } from '@/utils/adapt';

export const getOpenAIApi = (apiKey: string) => {
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  return new OpenAIApi(
    new Configuration({
      basePath: apiKey === process.env.ONEAPI_KEY ? process.env.ONEAPI_URL : openaiBaseUrl
    })
  );
};

/* 模型对话 */
export const chatResponse = async ({
  model,
  apiKey,
  temperature,
  maxToken = 4000,
  messages,
  stream
}: ChatCompletionType & { model: `${OpenAiChatEnum}` }) => {
  const modelTokenLimit = ChatModelMap[model]?.contextMaxToken || 4000;
  const filterMessages = ChatContextFilter({
    model,
    prompts: messages,
    maxTokens: Math.ceil(modelTokenLimit - 300) // filter token. not response maxToken
  });

  const adaptMessages = adaptChatItem_openAI({ messages: filterMessages, reserveId: false });
  const chatAPI = getOpenAIApi(apiKey);

  const promptsToken = modelToolMap.countTokens({
    model,
    messages: filterMessages
  });

  maxToken = maxToken + promptsToken > modelTokenLimit ? modelTokenLimit - promptsToken : maxToken;

  const response = await chatAPI.createChatCompletion(
    {
      model,
      temperature: Number(temperature || 0),
      max_tokens: maxToken,
      messages: adaptMessages,
      frequency_penalty: 0.5, // 越大，重复内容越少
      presence_penalty: -0.5, // 越大，越容易出现新内容
      stream
      // stop: ['.!?。']
    },
    {
      timeout: stream ? 60000 : 480000,
      responseType: stream ? 'stream' : 'json',
      ...axiosConfig(apiKey)
    }
  );

  const responseText = stream ? '' : response.data.choices?.[0].message?.content || '';
  const totalTokens = stream ? 0 : response.data.usage?.total_tokens || 0;

  return {
    streamResponse: response,
    responseMessages: filterMessages.concat({ obj: 'AI', value: responseText }),
    responseText,
    totalTokens
  };
};

/* openai stream response */
export const openAiStreamResponse = async ({
  res,
  model,
  chatResponse,
  prompts
}: StreamResponseType & {
  model: `${OpenAiChatEnum}`;
}) => {
  try {
    let responseContent = '';

    const clientRes = async (data: string) => {
      const { content = '' } = (() => {
        try {
          const json = JSON.parse(data);
          const content: string = json?.choices?.[0].delta.content || '';
          responseContent += content;
          return { content };
        } catch (error) {
          return {};
        }
      })();

      if (data === '[DONE]') return;

      !res.closed && content && res.write(content);
    };

    try {
      for await (const chunk of chatResponse.data as any) {
        if (res.closed) break;

        const parse = parseStreamChunk(chunk);
        parse.forEach((item) => clientRes(item.data));
      }
    } catch (error) {
      console.log('pipe error', error);
    }

    // count tokens
    const finishMessages = prompts.concat({
      obj: ChatRoleEnum.AI,
      value: responseContent
    });

    const totalTokens = modelToolMap.countTokens({
      model,
      messages: finishMessages
    });

    return {
      responseContent,
      totalTokens,
      finishMessages
    };
  } catch (error) {
    return Promise.reject(error);
  }
};
