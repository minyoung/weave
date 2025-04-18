import {ProviderV1} from '@ai-sdk/provider';
import {convertAsyncIteratorToReadableStream} from '@ai-sdk/provider-utils';
import {type LanguageModelV1Middleware} from 'ai';

import {op} from '../op';

export const weaveLanguageModelMiddleware: LanguageModelV1Middleware = {
  wrapGenerate: async ({doGenerate}) => {
    return op(doGenerate, {
      parameterNames: 'useParam0Object',
      // @ts-expect-error doGenerate does not accept args, but we want to pass args to it for weave.op to capture
    })(params);
  },

  wrapStream: async ({doStream, params}) => {
    return makeDoStreamOp(doStream)(params);
  },
};

function makeDoStreamOp(originalFn: any) {
  async function wrapped(...args: Parameters<typeof originalFn>) {
    let result: any;
    async function doStream(...args: any[]) {
      result = await originalFn(...args);
      return result.stream;
    }
    const weaveOp = op(doStream, {
      parameterNames: 'useParam0Object',
      streamReducer: {
        // TODO: is this the shape of the result that we want?
        initialState: {
          content: {
            text: '',
            reasoning: '',
            toolCalls: [],
          },
        },
        reduceFn(state, chunk) {
          const {type, ...rest} = chunk;
          switch (type) {
            case 'text-delta':
              state.content.text += chunk.textDelta;
              break;
            case 'reasoning':
              state.content.reasoning += chunk.textDelta;
              break;
            // TODO: tool-call-delta
            case 'tool-call':
              state.content.toolCalls.push(rest);
              break;
            case 'response-metadata':
              Object.assign(state, rest);
              if (state.timestamp) {
                state.timestamp = (state.timestamp as Date).toISOString();
              }
              break;
            case 'finish':
            case 'error':
              Object.assign(state, rest);
              break;
          }
          return state;
        },
      },
    });

    const stream = await weaveOp(...args);
    return {
      ...result,
      stream: convertAsyncIteratorToReadableStream(
        stream[Symbol.asyncIterator]()
      ),
    };
  }
  return wrapped;
}

function makeLanguageModelProxy(targetVal: any) {
  return new Proxy(targetVal, {
    get(target, p, receiver) {
      const targetVal = Reflect.get(target, p, receiver);
      if (p === 'doGenerate') {
        return op(targetVal.bind(target), {parameterNames: 'useParam0Object'});
      } else if (p === 'doStream') {
        return makeDoStreamOp(targetVal.bind(target));
      }

      return targetVal;
    },
  });
}

export function wrapAIProvider(provider: ProviderV1) {
  const languageModelProxy = new Proxy(provider.languageModel, {
    apply(target, thisArg, argArray) {
      const targetVal = Reflect.apply(target, thisArg, argArray);
      return makeLanguageModelProxy(targetVal);
    },
  });

  return new Proxy(provider, {
    get(target, p, receiver) {
      if (p === 'languageModel') {
        return languageModelProxy;
      }
      const targetVal = Reflect.get(target, p, receiver);
      return targetVal;
    },
  });
}
