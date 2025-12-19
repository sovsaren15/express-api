const express = require("express")
const router = express.Router()
// Ensure you have an EmployeeController with checkIn and checkOut methods
const employeeController = require("../controllers/employeeController")
const { authenticateToken } = require("../middleware/authMiddleware")


router.post("/checkin", authenticateToken, employeeController.checkIn)
router.post("/checkout", authenticateToken, employeeController.checkOut)
router.get("/attendance-history", authenticateToken, employeeController.getAttendanceHistory)
router.get("/all-employees", authenticateToken, employeeController.getAllEmployees)
module.exports = router