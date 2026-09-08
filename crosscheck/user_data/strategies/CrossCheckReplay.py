"""Cross-check strategy — replays the TypeScript engine's entry decisions.

This strategy computes NO indicators and makes NO decisions of its own. It
reads the entry bar timestamps chosen by src/strategy/backtest.ts and enters on
exactly those bars. Everything after the entry — fill price, stop-loss, take
profit, the 4h horizon exit, fees, P&L — is freqtrade's own execution engine.

That is the entire point. All eight of this project's measurement artifacts
(specs/profit-target-roadmap.md §2.5) lived in the execution and accounting
layer, not in signal generation. Reimplementing the signal logic in pandas
would have added divergence risk without testing the part that has actually
been wrong. Sharing the signals and comparing the execution isolates the layer
under suspicion.

Alignment note: our engine fills at the signal bar's CLOSE; freqtrade fills at
the NEXT bar's OPEN. Those are the same price — verified equal on all 105,120
candles in the dataset — so no timestamp shift is applied.
"""
from datetime import datetime
from functools import lru_cache
import json
import os

from pandas import DataFrame

from freqtrade.persistence import Trade
from freqtrade.strategy import IStrategy


SIGNALS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "entry_signals.json"
)


@lru_cache(maxsize=1)
def _signals() -> dict:
    with open(os.path.abspath(SIGNALS_PATH)) as f:
        return json.load(f)


class CrossCheckReplay(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "5m"
    can_short = False

    # Barriers, matching the TypeScript config exactly.
    # TP 1.5% / SL 1.5%, and a hard 4h horizon handled in custom_exit.
    stoploss = -0.015
    minimal_roi = {"0": 0.015}

    trailing_stop = False
    use_exit_signal = False
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    # No indicators are computed, so no warmup is needed. The lead-in candles
    # exported by prepare.py exist only so freqtrade has history at the left
    # edge of the range.
    startup_candle_count = 0
    process_only_new_candles = True

    # Exit at the exact stop/ROI price rather than at the candle's close, so
    # the barrier arithmetic matches the TypeScript engine's, which triggers
    # on the bar's high/low touching the barrier.
    use_custom_stoploss = False
    order_types = {
        "entry": "market",
        "exit": "market",
        "stoploss": "market",
        "stoploss_on_exchange": False,
    }

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        pair = metadata["pair"].split(":")[0].replace("/", "_")
        wanted = set(_signals()["signals"].get(pair, []))
        # `date` is a tz-aware timestamp; compare in epoch ms, the same unit
        # the TypeScript side recorded.
        epoch_ms = dataframe["date"].astype("int64") // 10**6
        dataframe["enter_long"] = epoch_ms.isin(wanted).astype(int)
        dataframe["enter_tag"] = "ts_replay"
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["exit_long"] = 0
        return dataframe

    def custom_exit(
        self,
        pair: str,
        trade: Trade,
        current_time: datetime,
        current_rate: float,
        current_profit: float,
        **kwargs,
    ):
        """The horizon exit: force-close after 4h regardless of P&L.

        This is the exit that the TypeScript engine could never actually fire
        in a backtest, because executor.ts stamped fills with Date.now()
        instead of the candle's own timestamp — making the position's measured
        age negative. It is modelled explicitly here so the two engines can be
        compared on the exit path that was broken.
        """
        horizon_minutes = _signals()["strategy"]["horizonMinutes"]
        held = (current_time - trade.open_date_utc).total_seconds() / 60
        if held >= horizon_minutes:
            return "horizon"
        return None
