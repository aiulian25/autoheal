import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "../../shared/api.js";
import type { BoardService } from "./board-service.js";

export function registerBoardRoutes(app: FastifyInstance, boardService: BoardService) {
  app.get(API_ROUTES.board, async (request) => boardService.board(request.authSession!.user.id));
}
