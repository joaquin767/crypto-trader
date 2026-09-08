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
    # TP 1.5% / SL 1.5% as GROSS price moves, plus a hard 4h horizon in
    # custom_exit.
    #
    # stoploss is a price ratio against open_rate, so -0.015 is already a
    # 1.5% gross move and matches directly.
    stoploss = -0.015
    #
    # minimal_roi is NOT: it is checked against profit_ratio, which is NET of
    # both fees. Setting it to 0.015 therefore demands a 1.611% gross move,
    # and the cross-check showed exactly that — every take-profit exit came
    # in 0.11pp above ours, the round-trip fee. The gross-equivalent is
    #     (1.015 * (1 - f)) / (1 + f) - 1  =  0.013884   at f = 0.00055
    minimal_roi = {"0": 0.013884}

    trailing_stop = False
    # MUST be True, even though populate_exit_trend emits no signals:
    # freqtrade only calls custom_exit() inside `if self.use_exit_signal:`
    # (strategy/interface.py:1469). With it False the 4h horizon exit is never
    # evaluated and trades run to a barrier instead — observed directly: a
    # 14h20m trade under a 4h horizon.
    use_exit_signal = True
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

        # Convert to epoch ms EXPLICITLY via datetime64[ms].
        #
        # Do not use `.astype("int64") // 10**6`. That assumes the column is
        # datetime64[ns], which was true historically but is not here: under
        # pandas 3 / freqtrade 2026.8 this column is already datetime64[ms,
        # UTC], so astype("int64") yields milliseconds and the divide turns
        # 1765088400000 into 1765088 — silently matching nothing and
        # producing a backtest with zero trades and no error.
        epoch_ms = dataframe["date"].astype("datetime64[ms, UTC]").astype("int64")

        dataframe["enter_long"] = epoch_ms.isin(wanted).astype(int)
        dataframe["enter_tag"] = "ts_replay"

        # Fail loudly if the replay did not line up. A silent zero here would
        # look exactly like "the strategy made no trades", which is the one
        # outcome this cross-check must never confuse with a real result.
        matched = int(dataframe["enter_long"].sum())
        if wanted and matched != len(wanted):
            raise ValueError(
                f"{pair}: replayed {matched} of {len(wanted)} exported entry signals. "
                "The signal timestamps do not align with the candle index — "
                "refusing to produce a misleading comparison."
            )
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
