import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type FontSize = "small" | "medium" | "large";

interface FontSizeContextType {
  fontSize: FontSize;
  setFontSize: (size: FontSize) => void;
}

const FontSizeContext = createContext<FontSizeContextType>({
  fontSize: "medium",
  setFontSize: () => {},
});

const FONT_SIZE_KEY = "field-ops-font-size";

export function FontSizeProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSizeState] = useState<FontSize>(() => {
    try {
      const stored = localStorage.getItem(FONT_SIZE_KEY);
      if (stored === "small" || stored === "medium" || stored === "large") {
        return stored;
      }
    } catch {}
    return "medium";
  });

  useEffect(() => {
    try {
      localStorage.setItem(FONT_SIZE_KEY, fontSize);
    } catch {}
    // Apply font size class to document root (works with CSS --font-scale variable)
    const root = document.documentElement;
    root.classList.remove("font-size-small", "font-size-medium", "font-size-large");
    root.classList.add(`font-size-${fontSize}`);
  }, [fontSize]);

  const setFontSize = (size: FontSize) => {
    setFontSizeState(size);
  };

  return (
    <FontSizeContext.Provider value={{ fontSize, setFontSize }}>
      {children}
    </FontSizeContext.Provider>
  );
}

export function useFontSize() {
  return useContext(FontSizeContext);
}
