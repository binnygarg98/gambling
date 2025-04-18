'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    await queryInterface.createTable('spins', {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      user_coupon_id: {
        type: Sequelize.BIGINT,
        allowNull : true,
        references : {
          model: {
            tableName: 'user_coupons',
            // schema: 'schema',
          },
          key: 'id',
        },
        onUpdate: 'CASCADE'
      },
      prize_amount : {
        type : Sequelize.DOUBLE,
        allowNull: false,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updated_at: {
        allowNull: true,
        type: Sequelize.DATE
      },
      deleted_at : {
        type : Sequelize.DATE,
        defaultValue : null,
      },
    })
  },

  async down (queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
    await queryInterface.dropTable('spins');
  }
};
