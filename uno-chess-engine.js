
"use strict";

const { Chess } = require("chess.js");

// =====================================
// UNO.CHESS ENGINE
// Moteur d'analyse maison
// =====================================

const UNO_ENGINE = {
  name: "UNO.CHESS ENGINE",
  version: "1.0.0",
  maxDepth: 5,

  pieceValues: {
    p: 100,
    n: 320,
    b: 330,
    r: 500,
    q: 900,
    k: 20000
  }
};

// =====================================
// ÉVALUATION DU MATÉRIEL
// =====================================

function evaluateMaterial(game) {
  const board = game.board();
  let score = 0;

  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;

      const value = UNO_ENGINE.pieceValues[piece.type];

      score += piece.color === "w"
        ? value
        : -value;
    }
  }

  return score;
}

// =====================================
// CONTRÔLE DU CENTRE
// =====================================

function evaluateCenter(game) {
  const centerSquares = [
    "d4", "e4",
    "d5", "e5"
  ];

  let score = 0;

  for (const square of centerSquares) {
    const attackersWhite =
      game.attackers(square, "w").length;

    const attackersBlack =
      game.attackers(square, "b").length;

    score += (attackersWhite - attackersBlack) * 8;
  }

  return score;
}

// =====================================
// MOBILITÉ
// =====================================

function evaluateMobility(game) {
  const currentTurn = game.turn();

  const currentMoves = game.moves().length;

  const copy = new Chess(game.fen());

  copy.load(game.fen());

  const fenParts = game.fen().split(" ");
  fenParts[1] = currentTurn === "w" ? "b" : "w";

  try {
    copy.load(fenParts.join(" "));
  } catch {
    return 0;
  }

  const opponentMoves = copy.moves().length;

  const difference = currentTurn === "w"
    ? currentMoves - opponentMoves
    : opponentMoves - currentMoves;

  return difference * 2;
}

// =====================================
// ÉVALUATION COMPLÈTE
// =====================================

function evaluatePosition(game) {
  if (game.isCheckmate()) {
    return game.turn() === "w"
      ? -100000
      : 100000;
  }

  if (
    game.isDraw() ||
    game.isStalemate() ||
    game.isThreefoldRepetition() ||
    game.isInsufficientMaterial()
  ) {
    return 0;
  }

  return (
    evaluateMaterial(game) +
    evaluateCenter(game) +
    evaluateMobility(game)
  );
}

// =====================================
// RECHERCHE MINIMAX + ALPHA-BÊTA
// =====================================

function minimax(game, depth, alpha, beta, maximizingPlayer) {
  if (depth === 0 || game.isGameOver()) {
    return evaluatePosition(game);
  }

  const moves = game.moves({ verbose: true });

  if (maximizingPlayer) {
    let bestScore = -Infinity;

    for (const move of moves) {
      game.move(move);

      const score = minimax(
        game,
        depth - 1,
        alpha,
        beta,
        false
      );

      game.undo();

      bestScore = Math.max(bestScore, score);
      alpha = Math.max(alpha, bestScore);

      if (beta <= alpha) break;
    }

    return bestScore;
  }

  let bestScore = Infinity;

  for (const move of moves) {
    game.move(move);

    const score = minimax(
      game,
      depth - 1,
      alpha,
      beta,
      true
    );

    game.undo();

    bestScore = Math.min(bestScore, score);
    beta = Math.min(beta, bestScore);

    if (beta <= alpha) break;
  }

  return bestScore;
}

// =====================================
// MEILLEUR COUP
// =====================================

function findBestMove(game, depth = 3) {
  const moves = game.moves({ verbose: true });

  if (moves.length === 0) {
    return null;
  }

  const maximizingPlayer = game.turn() === "w";
  let bestMove = null;

  let bestScore = maximizingPlayer
    ? -Infinity
    : Infinity;

  for (const move of moves) {
    game.move(move);

    const score = minimax(
      game,
      depth - 1,
      -Infinity,
      Infinity,
      !maximizingPlayer
    );

    game.undo();

    if (
      (maximizingPlayer && score > bestScore) ||
      (!maximizingPlayer && score < bestScore)
    ) {
      bestScore = score;
      bestMove = move;
    }
  }

  return {
    move: bestMove,
    score: bestScore,
    depth
  };
}


// =====================================
// GÉNÉRATEUR DE PROBLÈMES
// MAT EN 1 COUP
// =====================================

function findMateInOne(match, side) {
  const game = new Chess(match.chess.fen());

  if (game.turn() !== side) {
    return null;
  }

  const hand = match.hands[side] || [];
  const moves = game.moves({ verbose: true });

  for (let cardIndex = 0; cardIndex < hand.length; cardIndex++) {
    const card = hand[cardIndex];

    const cardMatches =
      card.color === "joker" ||
      card.color === match.activeColor ||
      card.value === match.discard.value;

    if (!cardMatches) continue;

    for (const move of moves) {
      const allowedPiece =
        card.color === "joker" ||
        (card.color === "rouge" &&
          (move.piece === "r" || move.piece === "q")) ||
        (card.color === "bleu" && move.piece === "n") ||
        (card.color === "vert" && move.piece === "b") ||
        (card.color === "jaune" && move.piece === "p");

      if (!allowedPiece) continue;

      const testGame = new Chess(game.fen());

      const played = testGame.move({
        from: move.from,
        to: move.to,
        promotion: "q"
      });

      if (!played) continue;

      if (testGame.isCheckmate()) {
        return {
          type: "mate-in-one",
          fen: game.fen(),
          side,
          card,
          cardIndex,
          move: {
            from: played.from,
            to: played.to,
            san: played.san
          },
          solution: played.san
        };
      }
    }
  }

  return null;
}
// =====================================
// TEST DU GÉNÉRATEUR DE MAT
// =====================================



function testMateGenerator() {
  const game = new Chess(
    "7k/8/5KQ1/8/8/8/8/8 w - - 0 1"
  );

  const match = {
    chess: game,
    hands: {
      w: [{ value: "5", color: "rouge" }],
      b: []
    },
    activeColor: "rouge",
    discard: { value: "5", color: "rouge" }
  };

  return findMateInOne(match, "w");
}

function generateMateInOnePuzzle(maxAttempts = 300) {
  const colors = ["rouge", "bleu", "vert", "jaune"];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const game = new Chess();

    // Créer une position légale avec des coups aléatoires
    const randomPlies = 8 + Math.floor(Math.random() * 38);

    for (let i = 0; i < randomPlies; i++) {
      const moves = game.moves({ verbose: true });

      if (moves.length === 0) break;

      const move = moves[Math.floor(Math.random() * moves.length)];

      game.move({
        from: move.from,
        to: move.to,
        promotion: "q"
      });
    }

    if (game.isGameOver()) continue;

    // Tester les quatre couleurs de cartes
    for (const color of colors) {
      const match = {
        chess: game,
        hands: {
          [game.turn()]: [{ value: "5", color }]
        },
        activeColor: color,
        discard: { value: "5", color }
      };

      const puzzle = findMateInOne(match, game.turn());

      if (puzzle) {
        return {
          ...puzzle,
          id: "UNO-MATE-" + Date.now(),
          attempts: attempt + 1
        };
      }
    }
  }

  return null;
}



// =====================================
// EXPORTS
// =====================================

// =====================================
// GENERATION DES ACTIONS UNO.CHESS
// =====================================

function generateUnoActions(game, hand, match) {
  const actions = [];
  if (
  !game ||
  !Array.isArray(hand) ||
  !match ||
  !match.discard
) {
  return [];
}
  const legalMoves = game.moves({ verbose: true });

  for (let cardIndex = 0; cardIndex < hand.length; cardIndex++) {
    const card = hand[cardIndex];

    const matches =
      card.color === "joker" ||
      card.color === match.activeColor ||
      card.value === match.discard.value;

    if (!matches) continue;

    for (const move of legalMoves) {
      const piece = move.piece;

      const allowed =
        card.color === "joker" ||
        (card.color === "rouge" &&
          (piece === "r" || piece === "q")) ||
        (card.color === "bleu" && piece === "n") ||
        (card.color === "vert" && piece === "b") ||
        (card.color === "jaune" && piece === "p");

      if (!allowed) continue;

      actions.push({
        type: "play",
        cardIndex,
        card,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        san: move.san
      });
    }
  }

  if (actions.length === 0) {
    actions.push({ type: "draw" });
  }

  return actions;
}

// =====================================
// SIMULATION DES ACTIONS UNO.CHESS
// =====================================

function simulateUnoAction(game, hand, match, action) {
  if (
    !game ||
    !Array.isArray(hand) ||
    !match ||
    !action ||
    action.type !== "play" ||
    !Number.isInteger(action.cardIndex) ||
    !hand[action.cardIndex]
  ) {
    return null;
  }

  const card = hand[action.cardIndex];

  const nextGame = new Chess(game.fen());
  const nextHand = hand.map(c => ({ ...c }));

  const nextMatch = {
    ...match,
    discard: { ...match.discard },
    hands: match.hands
      ? {
          w: match.hands.w.map(c => ({ ...c })),
          b: match.hands.b.map(c => ({ ...c }))
        }
      : undefined
  };

  const move = nextGame.move({
    from: action.from,
    to: action.to,
    promotion: action.promotion || "q"
  });

  if (!move) return null;

  nextHand.splice(action.cardIndex, 1);
  nextMatch.discard = { ...card };

  const penalties = {
    "+2": 2,
    "+4": 4,
    "+6": 6,
    "+10": 10
  };

  const penalty = penalties[card.value] || 0;

  if (card.value === "PASSE") {
    if (nextMatch.opponentHand) {
      nextMatch.opponentHand =
        nextMatch.opponentHand.slice(1);
    }
  }

  if (penalty > 0) {
    nextMatch.pendingPenalty = penalty;
  }

  if (
    card.color === "joker" ||
    card.value === "↔"
  ) {
    nextMatch.activeColor = null;
  } else {
    nextMatch.activeColor = card.color;
  }

  return {
    game: nextGame,
    hand: nextHand,
    match: nextMatch,
    move,
    card
  };
}


module.exports = {
  UNO_ENGINE,
  evaluateMaterial,
  evaluateCenter,
  evaluateMobility,
  evaluatePosition,
  minimax,
  findBestMove,
  findMateInOne,
  testMateGenerator,
  generateMateInOnePuzzle,
  generateUnoActions,
  simulateUnoAction
};
