const express = require("express")
const router = express.Router()
const adminController = require("../controllers/AdminController")
const employeeController = require("../controllers/employeeController")
const { authenticateToken } = require("../middleware/authMiddleware")

router.post("/employees", authenticateToken, adminController.createEmployee)
router.get("/attendance-history", authenticateToken, adminController.getAllAttendanceHistory)
router.get("/top-performers", authenticateToken, adminController.getTopPerformers)

// Employee management routes
router.get("/employees", authenticateToken, employeeController.getAllEmployees)
router.delete("/employees/:id", authenticateToken, employeeController.deleteEmployee)

module.exports = router