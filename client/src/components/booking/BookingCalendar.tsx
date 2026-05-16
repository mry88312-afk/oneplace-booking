import React, { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getTaipeiNow, toDateStr } from "./utils";

interface BookingCalendarProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  availableDays: number[];
  bookableDaysAhead: number;
  datesWithSlots: Set<string>;
  multiDayLoaded: boolean;
  minLeadDays?: number;
}

export function BookingCalendar({
  selectedDate, onSelectDate, availableDays, bookableDaysAhead, datesWithSlots, multiDayLoaded, minLeadDays,
}: BookingCalendarProps) {
  const today = getTaipeiNow();
  const todayStr = toDateStr(today);
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());

  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + (bookableDaysAhead || 14));
  const maxDateStr = toDateStr(maxDate);

  // 最早可預約日期：今天 + minLeadDays（填 2 = 跳過今天和明天，從後天開始）
  const minDate = new Date(today);
  minDate.setDate(minDate.getDate() + (minLeadDays || 0));
  const minDateStr = toDateStr(minDate);

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const weekdayHeaders = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const lastDay = new Date(viewYear, viewMonth + 1, 0);
    const startPad = firstDay.getDay();

    const days: Array<{
      date: string; day: number; isCurrentMonth: boolean; isAvailable: boolean; isToday: boolean;
    }> = [];

    for (let i = 0; i < startPad; i++) {
      const d = new Date(viewYear, viewMonth, -startPad + i + 1);
      days.push({ date: toDateStr(d), day: d.getDate(), isCurrentMonth: false, isAvailable: false, isToday: false });
    }

    for (let d = 1; d <= lastDay.getDate(); d++) {
      const dateObj = new Date(viewYear, viewMonth, d);
      const ds = toDateStr(dateObj);
      const dayOfWeek = dateObj.getDay();
      const isPast = ds < minDateStr;
      const isBeyondMax = ds > maxDateStr;
      const hasRule = availableDays.includes(dayOfWeek);
      const hasActualSlots = multiDayLoaded ? datesWithSlots.has(ds) : hasRule;

      days.push({ date: ds, day: d, isCurrentMonth: true, isAvailable: !isPast && !isBeyondMax && hasActualSlots, isToday: ds === todayStr });
    }

    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(viewYear, viewMonth + 1, i);
      days.push({ date: toDateStr(d), day: d.getDate(), isCurrentMonth: false, isAvailable: false, isToday: false });
    }

    return days;
  }, [viewYear, viewMonth, todayStr, minDateStr, maxDateStr, availableDays, multiDayLoaded, datesWithSlots]);

  const canGoPrev = viewYear > today.getFullYear() || (viewYear === today.getFullYear() && viewMonth > today.getMonth());
  const canGoNext = viewYear < maxDate.getFullYear() || (viewYear === maxDate.getFullYear() && viewMonth < maxDate.getMonth());

  return (
    <div className="select-none">
      <div className="flex items-center justify-center gap-4 mb-6">
        <button type="button"
          className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-gray-100 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
          disabled={!canGoPrev}
          onClick={() => { if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); } else { setViewMonth(viewMonth - 1); } }}>
          <ChevronLeft className="h-5 w-5 text-gray-600" />
        </button>
        <h3 className="text-lg font-bold text-gray-900 min-w-[180px] text-center">{monthNames[viewMonth]} {viewYear}</h3>
        <button type="button"
          className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-gray-100 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
          disabled={!canGoNext}
          onClick={() => { if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); } else { setViewMonth(viewMonth + 1); } }}>
          <ChevronRight className="h-5 w-5 text-gray-600" />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-2">
        {weekdayHeaders.map((w) => (
          <div key={w} className="text-center text-xs font-semibold text-gray-400 tracking-wider py-2">{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {calendarDays.map((cell, i) => {
          const isSelected = cell.date === selectedDate;
          return (
            <div key={i} className="flex items-center justify-center py-1">
              {cell.isCurrentMonth ? (
                cell.isAvailable ? (
                  <button type="button"
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold transition-all relative cursor-pointer
                      ${isSelected ? "bg-[#6B8E6B] text-white shadow-md" : "text-[#6B8E6B] hover:bg-[#6B8E6B]/10"}
                      ${cell.isToday && !isSelected ? "ring-2 ring-[#6B8E6B] ring-offset-1" : ""}`}
                    onClick={() => onSelectDate(cell.date)}>
                    {cell.day}
                    {!isSelected && <span className="absolute bottom-1 w-1 h-1 rounded-full bg-[#6B8E6B]" />}
                  </button>
                ) : (
                  <span className={`w-10 h-10 flex items-center justify-center text-sm ${cell.isToday ? "font-bold text-gray-700" : "text-gray-300"}`}>
                    {cell.day}
                  </span>
                )
              ) : (
                <span className="w-10 h-10 flex items-center justify-center text-sm text-gray-200">{cell.day}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
