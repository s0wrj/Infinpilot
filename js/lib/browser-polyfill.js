/**
 * This file is a polyfill for the `browser` namespace, which is used in
 * modern WebExtensions APIs. It allows extensions to use the `browser`
 * namespace and Promises in browsers that only support the `chrome`
 * namespace and callbacks (such as Google Chrome).
 *
 * For more information, see the [webextension-polyfill] repository on GitHub.
 *
 * [webextension-polyfill]: https://github.com/mozilla/webextension-polyfill
 */

/*
 * Copyright (c) 2017-2022 Mozilla Foundation and contributors
 * Released under the Mozilla Public License, v. 2.0.
 * https://github.com/mozilla/webextension-polyfill/blob/master/LICENSE.txt
 */

"use strict";

if (typeof browser === "undefined" || Object.getPrototypeOf(browser) !== Object.prototype) {
  const CHROME_SEND_MESSAGE_CALLBACK_NO_RESPONSE_MESSAGE = "The message port closed before a response was received.";
  const SEND_RESPONSE_DEPRECATION_WARNING = "Returning a Promise is the preferred way to send a reply from an onMessage/onMessageExternal listener, as the sendResponse will be removed in the future.";

  const wrapMethod = (dot, name, method, owner) => {
    if (name === "proxy") {
      return method;
    }

    return (...args) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        args.pop();
      }

      return new Promise((resolve, reject) => {
        const newCallback = (result) => {
          const { lastError } = chrome.runtime;
          if (lastError) {
            if (lastError.message === CHROME_SEND_MESSAGE_CALLBACK_NO_RESPONSE_MESSAGE) {
              resolve();
            } else {
              reject(lastError);
            }
          } else {
            resolve(result);
          }
        };

        if (typeof callback === "function") {
          method.call(owner, ...args, (...results) => {
            try {
              callback(...results);
            } catch (err) {
              console.error(
                `Uncaught exception in ${dot}.${name} callback`,
                err
              );
            }
            newCallback();
          });
        } else {
          method.call(owner, ...args, newCallback);
        }
      });
    };
  };

  const wrapEvent = (dot, name, event) => {
    const nameParts = name.split(".");
    if (nameParts[0] === "declarativeContent") {
      return event;
    }

    const listeners = new Set();

    return {
      ...event,
      addListener(callback, ...args) {
        if (listeners.has(callback)) {
          return;
        }
        listeners.add(callback);

        if (dot === "runtime" && name === "onMessage") {
          event.addListener((...listenerArgs) => {
            const sendResponse = listenerArgs[listenerArgs.length - 1];
            const wrappedSendResponse = (response) => {
              console.warn(SEND_RESPONSE_DEPRECATION_WARNING);
              sendResponse(response);
            };

            const newListenerArgs = [
              ...listenerArgs.slice(0, -1),
              wrappedSendResponse,
            ];

            const result = callback(...newListenerArgs);
            if (typeof result?.then === "function") {
              result.then(sendResponse, (err) => {
                console.error("Error processing async response", err);
              });
              return true;
            }
            return false;
          }, ...args);
        } else {
          event.addListener(callback, ...args);
        }
      },
      hasListener(callback) {
        return listeners.has(callback);
      },
      removeListener(callback) {
        if (listeners.has(callback)) {
          listeners.delete(callback);
          event.removeListener(callback);
        }
      },
    };
  };

  const wrapObject = (obj, dot = "") => {
    const newObj = {};
    for (const name of Object.keys(obj)) {
      const newName = name.startsWith("on") ? name : `on${name[0].toUpperCase()}${name.slice(1)}`;
      if (name === "get" || name === "set" || name === "clear" || name === "remove" || name === "add" || name === "has" || name === "delete") {
        newObj[name] = wrapMethod(dot, name, obj[name], obj);
      } else if (obj[name]?.addListener) {
        newObj[newName] = wrapEvent(dot, name, obj[name]);
      } else if (typeof obj[name] === "object" && obj[name] !== null) {
        newObj[name] = wrapObject(obj[name], `${dot}.${name}`);
      } else {
        newObj[name] = obj[name];
      }
    }
    return newObj;
  };

  globalThis.browser = wrapObject(chrome);
}
