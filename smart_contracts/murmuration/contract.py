# pyright: reportMissingModuleSource=false
"""MURMURATION - a flock counter with a quiet-round pot on Algorand TestNet.

Anyone may `join` the flock with a payment of at least 100,000 microALGO
(0.1 ALGO) into the app account. Every join grows the pot and resets the
quiet clock. When the flock goes quiet - when `quiet_rounds` pass with no
join - the next Arcron keeper call to `tick()` pays the FULL pot to the
last joiner. When the flock goes quiet, the last bird gets the pot.

The keeper hook is fail-soft by design (see the traps list in README.md):

  * Zero-argument hook. `tick()` takes no args; Arcron supplies none. A
    keeper decides *when* tick runs, never *what* it does.
  * Authorization is Application(keeper).address - the sender of Arcron's
    inner call. Never compare against itob(keeper_app_id); that is 8
    bytes, not an address.
  * FAIL SOFT. A hook that rejects gets backed off by keeper bots (1, 2,
    4... intervals) until the schedule quietly stops and burns escrow on
    retries. After the two authorization asserts, every no-work path here
    RETURNS 0 - nothing asserts once the keeper is authenticated.
  * Zero create args. A uint64 create_arg is how a sloppy deploy script
    confuses the keeper app id with a cadence and locks an interval at
    ~68 years. There is nothing to pass at create; the keeper is named
    once via `set_keeper`, the quiet window via `set_quiet`.

FEE NOTE: the inner payment's own fee is 0, so it draws from the group
fee pool. CorvidLabs keeper bots attach 2,000+ microALGO extra on the
outer execution, which covers it. See README.md.

TestNet only. Unaudited. Not deployed (appId = 0 until a human deploys).
"""

from typing import Final

from algopy import (
    ARC4Contract,
    Account,
    Application,
    Bytes,
    Global,
    GlobalState,
    Txn,
    UInt64,
    gtxn,
    itxn,
)
from algopy.arc4 import abimethod

# Rounds of silence before the pot pays out. 20000 rounds ~= 15.6 h at
# ~2.8 s/round. Initialized inside create() - NOT a create arg.
DEFAULT_QUIET_ROUNDS: Final = 20000

# Smallest quiet window `set_quiet` accepts. The floor keeps the payout
# window well outside any sane keeper cadence and stops the owner from
# turning tick into a per-call slot machine.
MIN_QUIET_ROUNDS: Final = 1000

# Minimum join payment: 100,000 microALGO = 0.1 ALGO.
MIN_JOIN: Final = 100000


class Murmuration(ARC4Contract):
    """Flock counter with a quiet-round pot, paid by Arcron keepers.

    TestNet only. Unaudited. Not a product.
    """

    def __init__(self) -> None:
        # App id of the Arcron keeper allowed to call `tick`. Zero until
        # `set_keeper`. Not an interval. Not a create arg.
        self.keeper_app = GlobalState(UInt64(0))
        # Total joins since deploy.
        self.flock = GlobalState(UInt64(0))
        # Accumulated join payments, in microALGO.
        self.pot = GlobalState(UInt64(0))
        # Round of the most recent join.
        self.last_join_round = GlobalState(UInt64(0))
        # Rounds of silence that trigger the payout. Owner-settable via
        # `set_quiet` (floor MIN_QUIET_ROUNDS).
        self.quiet_rounds = GlobalState(UInt64(0))
        # Address of the most recent joiner - the bird that wins the pot.
        self.last_joiner = GlobalState(Bytes())

    @abimethod(create="require")
    def create(self) -> None:
        """No-op create. Zero arguments on purpose.

        The 68-year trap: never take a uint64 create arg that a deploy
        script might map to the keeper app id. Nothing to pass here; the
        default quiet window (20000 rounds) is set right here.
        """
        self.keeper_app.value = UInt64(0)
        self.flock.value = UInt64(0)
        self.pot.value = UInt64(0)
        self.last_join_round.value = UInt64(0)
        self.quiet_rounds.value = UInt64(DEFAULT_QUIET_ROUNDS)
        self.last_joiner.value = Bytes()

    @abimethod()
    def set_keeper(self, keeper: Application) -> None:
        """Name the Arcron keeper whose app account may call `tick`.

        Creator-only, one-time. Pass the keeper *application*, not a raw
        uint64. `tick` authorizes Application(keeper).address - the
        inner-call sender when Arcron `execute()` inner-calls this app -
        never itob(keeper.id). Puya lowers the Application param to uint64
        in the ABI signature; the compiled selector is set_keeper(uint64)void.
        """
        assert Txn.sender == Global.creator_address, "Only the creator can set the keeper"
        assert self.keeper_app.value == 0, "Keeper already set"
        assert keeper.id != 0, "Keeper app required"
        self.keeper_app.value = keeper.id

    @abimethod()
    def set_quiet(self, quiet_rounds: UInt64) -> None:
        """Set the quiet window. Owner-only (owner = creator).

        Floor MIN_QUIET_ROUNDS (1000 rounds ~= 47 min): the window must
        never sit inside the keeper's own cadence.
        """
        assert Txn.sender == Global.creator_address, "Only the owner can set quiet"
        assert quiet_rounds >= MIN_QUIET_ROUNDS, "Quiet rounds below floor"
        self.quiet_rounds.value = quiet_rounds

    @abimethod()
    def join(self, payment: gtxn.PaymentTransaction) -> None:
        """Join the flock. Anyone may call with a payment attached.

        The payment must be at least 100,000 microALGO (0.1 ALGO) to the
        app account. Joining increments the flock, grows the pot by the
        full payment amount, resets the quiet clock, and makes the sender
        the bird in line for the pot.
        """
        assert payment.sender == Txn.sender, "Payment sender mismatch"
        assert (
            payment.receiver == Global.current_application_address
        ), "Payment must go to the app account"
        assert payment.amount >= MIN_JOIN, "Join costs at least 0.1 ALGO"
        assert payment.rekey_to == Global.zero_address, "Rekey not allowed"
        self.flock.value += 1
        self.pot.value += payment.amount
        self.last_join_round.value = Global.round
        self.last_joiner.value = Txn.sender.bytes

    @abimethod()
    def tick(self) -> UInt64:
        """Arcron hook. Zero arguments; the selector is the only app arg.

        Returns 1 the round the pot pays out, 0 on every no-work path.
        FAIL SOFT: after the two authorization asserts nothing here may
        reject - a failing hook gets exponentially backed off by keeper
        bots and burns upkeep escrow on retries.

        Empty flock, still-chatty flock, or empty pot: all return 0. Once
        `quiet_rounds` pass with no join, the full pot goes to the last
        joiner via an inner payment whose own fee is 0 - it draws from the
        group fee pool (keeper bots attach 2,000+ microALGO extra on the
        outer execution; see README.md).
        """
        keeper = self.keeper_app.value
        assert keeper != 0, "Keeper not set"
        # Inner-call sender is the keeper *app account*, not itob(keeper.id).
        assert (
            Txn.sender == Application(keeper).address
        ), "Only the keeper app may tick"

        # No flock, nothing to do. Return, do not assert.
        if self.flock.value == 0:
            return UInt64(0)

        # Empty pot, nothing to pay. Return, do not assert.
        pot = self.pot.value
        if pot == 0:
            return UInt64(0)

        # The flock is not quiet yet. Return, do not assert.
        if Global.round - self.last_join_round.value <= self.quiet_rounds.value:
            return UInt64(0)

        # QUIET - the last bird gets the pot. Fee 0 draws from the group pool.
        itxn.Payment(
            receiver=Account(self.last_joiner.value),
            amount=pot,
            fee=UInt64(0),
        ).submit()
        self.pot.value = UInt64(0)
        return UInt64(1)

    @abimethod(readonly=True)
    def status(self) -> UInt64:
        """Rounds of quiet so far. 0 if the flock is empty."""
        if self.flock.value == 0:
            return UInt64(0)
        return Global.round - self.last_join_round.value
