import type { PropsWithChildren } from 'react';
import { createContext, useMemo, useState } from 'react';
import type { MessageFormatElement } from 'react-intl';
import { IntlProvider } from 'react-intl';
import { useRequiredContext } from './react-helpers';

type IntlContextValue = [string, (locale: string) => void];

const intlContext = createContext<IntlContextValue | undefined>(undefined);

function loadMessages(locale: string): Record<string, MessageFormatElement[]> {
  try {
    return require(`./compiled-translations/${locale}.json`);
  } catch {
    return {};
  }
}

export const locales = [
  { code: 'en', name: 'English' },
  { code: 'bg', name: 'Български' },
  { code: 'es', name: 'español' },
  { code: 'fi', name: 'Suomi' },
  { code: 'sv', name: 'Svenska' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'zh', name: '简体中文' },
] as const;

export function IntlProviderWrapper({ children }: PropsWithChildren<{}>) {
  const [[locale, messages], setLocaleAndMessages] = useState(() => {
    // TODO: Default based on browser/OS setting
    const initialLocale = localStorage.getItem('locale') ?? 'en';
    return [initialLocale, loadMessages(initialLocale)];
  });
  const contextValue: IntlContextValue = useMemo(
    () => [
      locale,
      (newLocale) => {
        localStorage.setItem('locale', newLocale);
        setLocaleAndMessages([newLocale, loadMessages(newLocale)]);
      },
    ],
    [locale],
  );

  return (
    <intlContext.Provider value={contextValue}>
      <IntlProvider defaultLocale='en' locale={locale} messages={messages}>
        {children}
      </IntlProvider>
    </intlContext.Provider>
  );
}

export function useLocaleState() {
  return useRequiredContext(intlContext);
}
